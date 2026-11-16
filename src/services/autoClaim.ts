import { ethers } from 'ethers';
import { ENV } from '../config/env';
import {
    AutoClaimState,
    AUTO_CLAIM_STATE_ID,
    AUTO_CLAIM_HISTORY_LIMIT,
    AutoClaimHistoryEntry,
} from '../models/autoClaimState';
import { computeAutoClaim, snapBaseline } from '../utils/autoClaimMath';
import getMyBalance from '../utils/getMyBalance';
import Logger from '../utils/logger';
import { withdrawCollateralToWallet } from '../utils/withdrawCollateral';

/** Default: once per day. */
const DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60;
/** Wake often enough to honor Settings enable/disable without waiting a full day. */
const LOOP_WAKE_SECONDS = 60 * 60;

let isRunning = true;
let claimInFlight = false;

export const stopAutoClaim = () => {
    isRunning = false;
    Logger.info('Auto claim shutdown requested...');
};

const resolveRecipient = (): string | null => {
    const configured = (ENV.PAYOUT_ADDRESS || ENV.AUTO_CLAIM_RECIPIENT || '').trim();
    if (configured && ethers.utils.isAddress(configured)) {
        return ethers.utils.getAddress(configured);
    }

    const pk = ENV.PRIVATE_KEY?.trim();
    if (!pk) return null;
    try {
        const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
        return wallet.address;
    } catch {
        return null;
    }
};

const loadState = async (): Promise<{ baseline: number; lastCheckAt: Date | null }> => {
    const doc = (await AutoClaimState.findById(AUTO_CLAIM_STATE_ID).lean().exec()) as {
        baseline?: number;
        lastCheckAt?: Date | string;
    } | null;
    if (!doc) return { baseline: 0, lastCheckAt: null };
    const baseline =
        typeof doc.baseline === 'number' && Number.isFinite(doc.baseline) ? doc.baseline : 0;
    let lastCheckAt: Date | null = null;
    if (doc.lastCheckAt) {
        const d = doc.lastCheckAt instanceof Date ? doc.lastCheckAt : new Date(doc.lastCheckAt);
        if (!Number.isNaN(d.getTime())) lastCheckAt = d;
    }
    return { baseline, lastCheckAt };
};

const saveState = async (fields: {
    baseline?: number;
    lastCheckAt?: Date;
    lastPayoutUsd?: number;
    lastRecipient?: string;
    lastTxId?: string;
}): Promise<void> => {
    await AutoClaimState.findByIdAndUpdate(
        AUTO_CLAIM_STATE_ID,
        {
            $set: {
                ...fields,
                updatedAt: new Date(),
            },
            $setOnInsert: { _id: AUTO_CLAIM_STATE_ID, baseline: fields.baseline ?? 0 },
        },
        { upsert: true }
    );
};

const appendHistory = async (
    entry: AutoClaimHistoryEntry,
    fields: {
        baseline: number;
        lastCheckAt: Date;
        lastPayoutUsd: number;
        lastRecipient: string;
        lastTxId?: string;
    }
): Promise<void> => {
    await AutoClaimState.findByIdAndUpdate(
        AUTO_CLAIM_STATE_ID,
        {
            $set: {
                ...fields,
                updatedAt: new Date(),
            },
            $push: {
                history: {
                    $each: [entry],
                    $position: 0,
                    $slice: AUTO_CLAIM_HISTORY_LIMIT,
                },
            },
            $setOnInsert: { _id: AUTO_CLAIM_STATE_ID },
        },
        { upsert: true }
    );
};

const claimIntervalSeconds = (): number => {
    const n = ENV.AUTO_CLAIM_INTERVAL;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_SECONDS;
};

/**
 * One auto-claim pass: read CLOB cash, apply doubling ladder, withdraw to connected wallet.
 * At most once per AUTO_CLAIM_INTERVAL (default 24h), tracked via lastCheckAt in Mongo.
 */
export const runAutoClaimOnce = async (opts?: { force?: boolean }): Promise<void> => {
    if (ENV.PAPER_MODE) return;
    if (!ENV.AUTO_CLAIM_ENABLED) return;
    if (claimInFlight) return;

    claimInFlight = true;
    try {
        const intervalSec = claimIntervalSeconds();
        const { baseline: storedBaseline, lastCheckAt } = await loadState();

        if (!opts?.force && lastCheckAt) {
            const elapsedMs = Date.now() - lastCheckAt.getTime();
            if (elapsedMs < intervalSec * 1000) {
                const hoursLeft = ((intervalSec * 1000 - elapsedMs) / 3_600_000).toFixed(1);
                Logger.info(
                    `Auto claim skipped — next check in ~${hoursLeft}h ` +
                        `(once every ${Math.round(intervalSec / 3600)}h)`
                );
                return;
            }
        }

        // Mark this calendar check immediately so crashes mid-run don't spam retries.
        await saveState({ lastCheckAt: new Date(), baseline: storedBaseline });

        const funder = ENV.PROXY_WALLET?.trim();
        if (!funder) {
            Logger.warning('Auto claim skipped — PROXY_WALLET / POLY_FUNDER not set');
            return;
        }

        const recipient = resolveRecipient();
        if (!recipient) {
            Logger.warning(
                'Auto claim skipped — set PAYOUT_ADDRESS (or AUTO_CLAIM_RECIPIENT) or PRIVATE_KEY / POLY_PRIVATE_KEY'
            );
            return;
        }

        if (recipient.toLowerCase() === funder.toLowerCase()) {
            Logger.warning(
                'Auto claim skipped — recipient equals trading wallet (nothing to withdraw to)'
            );
            return;
        }

        const balance = await getMyBalance(funder);
        let baseline = storedBaseline;

        // Initialize baseline on first run without paying out.
        if (baseline <= 0) {
            const snapped = snapBaseline(balance);
            if (snapped > 0) {
                await saveState({ baseline: snapped, lastCheckAt: new Date() });
                Logger.info(
                    `Auto claim baseline initialized at $${snapped.toFixed(2)} (cash $${balance.toFixed(
                        2
                    )})`
                );
            } else {
                Logger.info(
                    `Auto claim waiting for cash ≥ $100 to set baseline (now $${balance.toFixed(2)})`
                );
            }
            return;
        }

        const plan = computeAutoClaim(balance, baseline);

        if (plan.newBaseline !== baseline && !plan.shouldClaim) {
            await saveState({ baseline: plan.newBaseline, lastCheckAt: new Date() });
            if (plan.newBaseline < baseline) {
                Logger.info(
                    `Auto claim baseline ratcheted $${baseline.toFixed(2)} → $${plan.newBaseline.toFixed(
                        2
                    )} (cash $${balance.toFixed(2)})`
                );
            }
            return;
        }

        if (!plan.shouldClaim) {
            Logger.info(
                `Auto claim check OK — cash $${balance.toFixed(2)}, baseline $${baseline.toFixed(
                    2
                )}, next claim ≥ $${(baseline * 2).toFixed(2)}`
            );
            return;
        }

        Logger.separator();
        Logger.info(
            `AUTO-CLAIM: cash $${balance.toFixed(2)} ≥ 2× baseline $${baseline.toFixed(
                2
            )} → pay out $${plan.payout.toFixed(2)} (${plan.levels} level(s)) to ${recipient}`
        );

        const result = await withdrawCollateralToWallet(plan.payout, recipient);
        if (!result.success) {
            Logger.error(`Auto claim withdraw failed: ${result.error || 'unknown'}`);
            return;
        }

        const paidAt = new Date();
        const txRef = result.txHash || result.txId || '';
        await appendHistory(
            {
                at: paidAt,
                amountUsd: plan.payout,
                recipient,
                txHash: result.txHash,
                txId: result.txId,
                baselineBefore: baseline,
                baselineAfter: plan.newBaseline,
                cashBefore: balance,
            },
            {
                baseline: plan.newBaseline,
                lastCheckAt: paidAt,
                lastPayoutUsd: plan.payout,
                lastRecipient: recipient,
                lastTxId: txRef || undefined,
            }
        );

        Logger.success(
            `Auto claim paid $${plan.payout.toFixed(2)} → ${recipient}` +
                (result.txHash ? ` tx=${result.txHash}` : result.txId ? ` relayer=${result.txId}` : '')
        );
        Logger.info(
            `   Logged payout @ ${paidAt.toISOString()}` +
                (txRef ? ` · ${result.txHash ? 'tx' : 'relayer'}=${txRef}` : '')
        );
        Logger.info(`   New baseline: $${plan.newBaseline.toFixed(2)} (next claim at ≥ $${(
            plan.newBaseline * 2
        ).toFixed(2)})`);
        Logger.separator();
    } catch (error) {
        Logger.error(
            `Auto claim error: ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        claimInFlight = false;
    }
};

const autoClaim = async () => {
    const hours = Math.round(claimIntervalSeconds() / 3600);
    Logger.success(
        `Auto claim loop started — checks at most once every ${hours}h ` +
            `(enable/disable from Settings; wake every ${LOOP_WAKE_SECONDS / 60}m)`
    );
    Logger.info('   Rule: 100→200 pay $50 · 150→300 pay $100 · 200→400 pay $150 · …');

    while (isRunning) {
        try {
            const { ENV: liveEnv } = await import('../config/env');
            if (!liveEnv.PAPER_MODE && liveEnv.AUTO_CLAIM_ENABLED) {
                await runAutoClaimOnce();
            }
        } catch (error) {
            Logger.error(`Auto claim loop error: ${error}`);
        }

        if (!isRunning) break;
        // Wake hourly so Settings toggles apply without waiting a full day.
        const wakeSec = Math.min(LOOP_WAKE_SECONDS, Math.max(60, claimIntervalSeconds()));
        await new Promise((resolve) => setTimeout(resolve, wakeSec * 1000));
    }

    Logger.info('Auto claim stopped');
};

export default autoClaim;
