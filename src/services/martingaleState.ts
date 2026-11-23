/**
 * Price-adjusted martingale circle:
 * - Fresh bet = baseShares × entry price
 * - After losses totaling L USD, next bet at price p sizes so a win recovers L
 *   and still nets baseShares × (1−p):
 *     shares = L/(1−p) + baseShares
 *     stake  = shares × p
 */
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';

export interface MartingaleState {
    /** Trailing loss count after the last win (0 = start of circle). */
    consecutiveLosses: number;
    /** Sum of stake USD lost since the last win (drives recovery sizing). */
    cumulativeLossUsd: number;
    /** Position keys already applied to the streak (conditionId:asset). */
    processedKeys: string[];
    updatedAt: number;
}

export interface MartingaleCircle {
    consecutiveLosses: number;
    cumulativeLossUsd: number;
}

interface MartingaleFile {
    live: MartingaleState;
    paper: MartingaleState;
}

const STATE_DIR = path.join(process.cwd(), 'trader_reports');
const STATE_PATH = path.join(STATE_DIR, 'martingale_state.json');
const MAX_PROCESSED = 500;

const emptyState = (): MartingaleState => ({
    consecutiveLosses: 0,
    cumulativeLossUsd: 0,
    processedKeys: [],
    updatedAt: Math.floor(Date.now() / 1000),
});

const parseSlot = (raw: Partial<MartingaleState> | undefined): MartingaleState => ({
    consecutiveLosses: Math.max(0, Number(raw?.consecutiveLosses) || 0),
    cumulativeLossUsd: Math.max(0, Number(raw?.cumulativeLossUsd) || 0),
    processedKeys: Array.isArray(raw?.processedKeys) ? raw!.processedKeys.map(String) : [],
    updatedAt: Number(raw?.updatedAt) || 0,
});

let cache: MartingaleFile | null = null;

const readFile = (): MartingaleFile => {
    if (cache) return cache;
    try {
        if (fs.existsSync(STATE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Partial<MartingaleFile>;
            cache = {
                live: parseSlot(raw.live),
                paper: parseSlot(raw.paper),
            };
            return cache;
        }
    } catch (error) {
        console.warn(
            `Martingale state read failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    cache = { live: emptyState(), paper: emptyState() };
    return cache;
};

const writeFile = (data: MartingaleFile): void => {
    try {
        if (!fs.existsSync(STATE_DIR)) {
            fs.mkdirSync(STATE_DIR, { recursive: true });
        }
        fs.writeFileSync(STATE_PATH, JSON.stringify(data, null, 2), 'utf-8');
        cache = data;
    } catch (error) {
        console.warn(
            `Martingale state write failed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

const slot = (paper: boolean): MartingaleState => {
    const file = readFile();
    return paper ? file.paper : file.live;
};

const saveSlot = (paper: boolean, next: MartingaleState): void => {
    const file = readFile();
    const updated: MartingaleFile = paper
        ? { ...file, paper: { ...next, updatedAt: Math.floor(Date.now() / 1000) } }
        : { ...file, live: { ...next, updatedAt: Math.floor(Date.now() / 1000) } };
    writeFile(updated);
};

export const positionKey = (conditionId: string, asset: string): string =>
    `${conditionId}:${asset}`.toLowerCase();

export const getMartingaleConsecutiveLosses = (paper = ENV.PAPER_MODE): number => {
    return slot(paper).consecutiveLosses;
};

export const getMartingaleCumulativeLossUsd = (paper = ENV.PAPER_MODE): number => {
    return slot(paper).cumulativeLossUsd;
};

export const getMartingaleCircle = (paper = ENV.PAPER_MODE): MartingaleCircle => {
    const s = slot(paper);
    return {
        consecutiveLosses: s.consecutiveLosses,
        cumulativeLossUsd: s.cumulativeLossUsd,
    };
};

/**
 * Legacy share doubling (even-odds approximation). Prefer martingaleRecoveryStake.
 */
export const martingaleSharesForStreak = (
    consecutiveLosses: number,
    baseShares: number,
    maxSteps: number
): number => {
    const base = Number.isFinite(baseShares) && baseShares > 0 ? baseShares : 5;
    const stepsCap = Number.isFinite(maxSteps) && maxSteps >= 0 ? maxSteps : 8;
    const losses = Math.max(0, Math.floor(consecutiveLosses));
    const steps = Math.min(losses, stepsCap);
    return base * Math.pow(2, steps);
};

/**
 * Price-adjusted recovery size: win at `entryPrice` recovers cumulative losses
 * and nets one base unit of profit (baseShares × (1 − price)).
 */
export const martingaleRecoveryStake = (opts: {
    baseShares: number;
    entryPrice: number;
    cumulativeLossUsd: number;
}): { shares: number; stakeUsd: number; targetProfitUsd: number } => {
    const baseShares =
        Number.isFinite(opts.baseShares) && opts.baseShares > 0 ? opts.baseShares : 5;
    const price = Math.min(Math.max(Number(opts.entryPrice) || 0.5, 0.01), 0.99);
    const loss = Math.max(0, Number(opts.cumulativeLossUsd) || 0);
    const winPerShare = 1 - price;
    const targetProfitUsd = baseShares * winPerShare;
    const shares = loss / winPerShare + baseShares;
    const stakeUsd = shares * price;
    return { shares, stakeUsd, targetProfitUsd };
};

/**
 * Apply a resolved outcome to the circle. Idempotent per position key.
 * Win → reset. Loss → streak++ and add lostUsd to the recovery pool.
 */
export const recordMartingaleResult = (
    won: boolean,
    key: string,
    paper = ENV.PAPER_MODE,
    lostUsd = 0
): { applied: boolean; consecutiveLosses: number; cumulativeLossUsd: number } => {
    const state = slot(paper);
    const normalized = key.toLowerCase();
    if (state.processedKeys.includes(normalized)) {
        return {
            applied: false,
            consecutiveLosses: state.consecutiveLosses,
            cumulativeLossUsd: state.cumulativeLossUsd,
        };
    }

    const consecutiveLosses = won ? 0 : state.consecutiveLosses + 1;
    const cumulativeLossUsd = won
        ? 0
        : state.cumulativeLossUsd + Math.max(0, Number(lostUsd) || 0);
    const processedKeys = [...state.processedKeys, normalized].slice(-MAX_PROCESSED);
    saveSlot(paper, {
        consecutiveLosses,
        cumulativeLossUsd,
        processedKeys,
        updatedAt: Math.floor(Date.now() / 1000),
    });

    console.log(
        `🎲 Martingale ${paper ? 'paper' : 'live'}: ${
            won
                ? 'WIN → reset'
                : `LOSS → streak ${consecutiveLosses}, recover $${cumulativeLossUsd.toFixed(2)}`
        } (${normalized.slice(0, 24)}…)`
    );

    return { applied: true, consecutiveLosses, cumulativeLossUsd };
};

/** Test helper / Settings reset. */
export const resetMartingaleState = (paper = ENV.PAPER_MODE): void => {
    saveSlot(paper, emptyState());
};

const RESOLVED_HIGH = 0.99;
const RESOLVED_LOW = 0.01;

/**
 * Feed current mark prices for held positions; apply newly resolved W/L to the circle.
 * Pass sizeUsd (cost basis) on losses so recovery sizing stays accurate.
 */
export const syncMartingaleFromPrices = (
    rows: Array<{
        conditionId?: string;
        asset?: string;
        curPrice?: number;
        size?: number;
        avgPrice?: number;
        sizeUsd?: number;
    }>,
    paper = ENV.PAPER_MODE
): MartingaleCircle => {
    for (const row of rows) {
        const conditionId = row.conditionId || '';
        const asset = row.asset || '';
        const price = Number(row.curPrice);
        if (!conditionId || !asset || !Number.isFinite(price)) continue;
        if (row.size != null && !(row.size > 1e-8) && price > RESOLVED_LOW && price < RESOLVED_HIGH) {
            continue;
        }
        if (price >= RESOLVED_HIGH) {
            recordMartingaleResult(true, positionKey(conditionId, asset), paper, 0);
        } else if (price <= RESOLVED_LOW) {
            const cost =
                Number(row.sizeUsd) > 0
                    ? Number(row.sizeUsd)
                    : Number(row.size) > 0 && Number(row.avgPrice) > 0
                      ? Number(row.size) * Number(row.avgPrice)
                      : 0;
            recordMartingaleResult(false, positionKey(conditionId, asset), paper, cost);
        }
    }
    return getMartingaleCircle(paper);
};

/**
 * Trailing consecutive losses from a chronological list of resolved outcomes
 * (walk newest → oldest until a win). Open/unresolved rows must be omitted.
 */
export const trailingLossStreak = (outcomesOldestFirst: Array<{ won: boolean }>): number => {
    let streak = 0;
    for (let i = outcomesOldestFirst.length - 1; i >= 0; i--) {
        if (outcomesOldestFirst[i].won) break;
        streak++;
    }
    return streak;
};

/** Trailing loss streak + sum of lost stakes since the last win. */
export const trailingLossCircle = (
    outcomesOldestFirst: Array<{ won: boolean; sizeUsd?: number }>
): MartingaleCircle => {
    let consecutiveLosses = 0;
    let cumulativeLossUsd = 0;
    for (let i = outcomesOldestFirst.length - 1; i >= 0; i--) {
        if (outcomesOldestFirst[i].won) break;
        consecutiveLosses++;
        cumulativeLossUsd += Math.max(0, Number(outcomesOldestFirst[i].sizeUsd) || 0);
    }
    return { consecutiveLosses, cumulativeLossUsd };
};

/** Overwrite circle state (used when rebuilding paper circle from the ledger). */
export const setMartingaleStreak = (
    consecutiveLosses: number,
    processedKeys: string[],
    paper = ENV.PAPER_MODE,
    cumulativeLossUsd = 0
): void => {
    saveSlot(paper, {
        consecutiveLosses: Math.max(0, Math.floor(consecutiveLosses)),
        cumulativeLossUsd: Math.max(0, Number(cumulativeLossUsd) || 0),
        processedKeys: processedKeys.map((k) => k.toLowerCase()).slice(-MAX_PROCESSED),
        updatedAt: Math.floor(Date.now() / 1000),
    });
};

const isResolvedWin = (price: number): boolean => price >= RESOLVED_HIGH;
const isResolvedLoss = (price: number): boolean => price <= RESOLVED_LOW;

/**
 * Rebuild paper martingale circle from entered paper BUY signals + mark prices.
 * Ignores still-open markets; recovery pool = sum of trailing losing stakes.
 */
export const rebuildMartingaleFromResolvedMarks = (
    rowsOldestFirst: Array<{
        conditionId: string;
        asset: string;
        curPrice: number;
        sizeUsd?: number;
    }>,
    paper = true
): MartingaleCircle => {
    const outcomes: Array<{ won: boolean; key: string; sizeUsd: number }> = [];
    const seen = new Set<string>();

    for (const row of rowsOldestFirst) {
        const key = positionKey(row.conditionId, row.asset);
        if (!row.conditionId || !row.asset || seen.has(key)) continue;
        const price = Number(row.curPrice);
        if (!Number.isFinite(price)) continue;
        if (isResolvedWin(price)) {
            seen.add(key);
            outcomes.push({ won: true, key, sizeUsd: 0 });
        } else if (isResolvedLoss(price)) {
            seen.add(key);
            outcomes.push({
                won: false,
                key,
                sizeUsd: Math.max(0, Number(row.sizeUsd) || 0),
            });
        }
    }

    const circle = trailingLossCircle(outcomes);
    setMartingaleStreak(
        circle.consecutiveLosses,
        outcomes.map((o) => o.key),
        paper,
        circle.cumulativeLossUsd
    );
    return circle;
};
