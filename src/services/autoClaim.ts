import { ethers } from 'ethers';
import { ENV } from '../config/env';
import { AutoClaimState, AUTO_CLAIM_STATE_ID } from '../models/autoClaimState';
import { computeAutoClaim, snapBaseline } from '../utils/autoClaimMath';
import getMyBalance from '../utils/getMyBalance';
import Logger from '../utils/logger';
import { withdrawCollateralToWallet } from '../utils/withdrawCollateral';

let isRunning = true;
let claimInFlight = false;

export const stopAutoClaim = () => {
    isRunning = false;
    Logger.info('Auto claim shutdown requested...');
};

const resolveRecipient = (): string | null => {
    const configured = (ENV.AUTO_CLAIM_RECIPIENT || '').trim();
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

const loadBaseline = async (): Promise<number> => {
    const doc = (await AutoClaimState.findById(AUTO_CLAIM_STATE_ID).lean().exec()) as {
        baseline?: number;
    } | null;
    if (!doc) return 0;
    return typeof doc.baseline === 'number' && Number.isFinite(doc.baseline) ? doc.baseline : 0;
};

const saveBaseline = async (fields: {
    baseline: number;
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
            $setOnInsert: { _id: AUTO_CLAIM_STATE_ID },
        },
        { upsert: true }
    );
};

/**
 * One auto-claim pass: read CLOB cash, apply doubling ladder, withdraw to connected wallet.
 */
export const runAutoClaimOnce = async (): Promise<void> => {
    if (ENV.PAPER_MODE) return;
    if (!ENV.AUTO_CLAIM_ENABLED) return;
    if (claimInFlight) return;

    claimInFlight = true;
    try {
        const funder = ENV.PROXY_WALLET?.trim();
        if (!funder) {
            Logger.warning('Auto claim skipped — PROXY_WALLET / POLY_FUNDER not set');
            return;
        }

        const recipient = resolveRecipient();
        if (!recipient) {
            Logger.warning(
                'Auto claim skipped — set AUTO_CLAIM_RECIPIENT or PRIVATE_KEY / POLY_PRIVATE_KEY'
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
        let baseline = await loadBaseline();

        // Initialize baseline on first run without paying out.
        if (baseline <= 0) {
            const snapped = snapBaseline(balance);
            if (snapped > 0) {
                await saveBaseline({ baseline: snapped });
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
            await saveBaseline({ baseline: plan.newBaseline });
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

        await saveBaseline({
            baseline: plan.newBaseline,
            lastPayoutUsd: plan.payout,
            lastRecipient: recipient,
            lastTxId: result.txId || result.txHash,
        });

        Logger.success(
            `Auto claim paid $${plan.payout.toFixed(2)} → ${recipient}` +
                (result.txHash ? ` tx=${result.txHash}` : result.txId ? ` relayer=${result.txId}` : '')
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
    if (!ENV.AUTO_CLAIM_ENABLED) {
        Logger.info('Auto claim is disabled');
        return;
    }

    Logger.success(
        `Auto claim started (every ${ENV.AUTO_CLAIM_INTERVAL}s) — double ladder, payout to connected wallet`
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
        await new Promise((resolve) => setTimeout(resolve, ENV.AUTO_CLAIM_INTERVAL * 1000));
    }

    Logger.info('Auto claim stopped');
};

export default autoClaim;
