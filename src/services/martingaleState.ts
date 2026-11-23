/**
 * Classic martingale circle state: consecutive losses since last win.
 * First bet = base shares (default 5); each loss doubles share count; a win resets.
 */
import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';

export interface MartingaleState {
    /** Trailing loss count after the last win (0 = start of circle). */
    consecutiveLosses: number;
    /** Position keys already applied to the streak (conditionId:asset). */
    processedKeys: string[];
    updatedAt: number;
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
    processedKeys: [],
    updatedAt: Math.floor(Date.now() / 1000),
});

let cache: MartingaleFile | null = null;

const readFile = (): MartingaleFile => {
    if (cache) return cache;
    try {
        if (fs.existsSync(STATE_PATH)) {
            const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as Partial<MartingaleFile>;
            cache = {
                live: {
                    consecutiveLosses: Math.max(0, Number(raw.live?.consecutiveLosses) || 0),
                    processedKeys: Array.isArray(raw.live?.processedKeys)
                        ? raw.live!.processedKeys.map(String)
                        : [],
                    updatedAt: Number(raw.live?.updatedAt) || 0,
                },
                paper: {
                    consecutiveLosses: Math.max(0, Number(raw.paper?.consecutiveLosses) || 0),
                    processedKeys: Array.isArray(raw.paper?.processedKeys)
                        ? raw.paper!.processedKeys.map(String)
                        : [],
                    updatedAt: Number(raw.paper?.updatedAt) || 0,
                },
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

/**
 * Share count for the next bet: base × 2^losses, capped by maxSteps.
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
 * Apply a resolved outcome to the circle. Idempotent per position key.
 * Win → reset to 0. Loss → consecutiveLosses++.
 */
export const recordMartingaleResult = (
    won: boolean,
    key: string,
    paper = ENV.PAPER_MODE
): { applied: boolean; consecutiveLosses: number } => {
    const state = slot(paper);
    const normalized = key.toLowerCase();
    if (state.processedKeys.includes(normalized)) {
        return { applied: false, consecutiveLosses: state.consecutiveLosses };
    }

    const consecutiveLosses = won ? 0 : state.consecutiveLosses + 1;
    const processedKeys = [...state.processedKeys, normalized].slice(-MAX_PROCESSED);
    saveSlot(paper, { consecutiveLosses, processedKeys, updatedAt: Math.floor(Date.now() / 1000) });

    console.log(
        `🎲 Martingale ${paper ? 'paper' : 'live'}: ${won ? 'WIN → reset' : `LOSS → streak ${consecutiveLosses}`} (${normalized.slice(0, 24)}…)`
    );

    return { applied: true, consecutiveLosses };
};

/** Test helper / Settings reset. */
export const resetMartingaleState = (paper = ENV.PAPER_MODE): void => {
    saveSlot(paper, emptyState());
};

const RESOLVED_HIGH = 0.99;
const RESOLVED_LOW = 0.01;

/**
 * Feed current mark prices for held positions; apply newly resolved W/L to the circle.
 * Returns the updated consecutive-loss streak.
 */
export const syncMartingaleFromPrices = (
    rows: Array<{ conditionId?: string; asset?: string; curPrice?: number; size?: number }>,
    paper = ENV.PAPER_MODE
): number => {
    for (const row of rows) {
        const conditionId = row.conditionId || '';
        const asset = row.asset || '';
        const price = Number(row.curPrice);
        if (!conditionId || !asset || !Number.isFinite(price)) continue;
        // Still need a held (or just-resolved) position to count
        if (row.size != null && !(row.size > 1e-8) && price > RESOLVED_LOW && price < RESOLVED_HIGH) {
            continue;
        }
        if (price >= RESOLVED_HIGH) {
            recordMartingaleResult(true, positionKey(conditionId, asset), paper);
        } else if (price <= RESOLVED_LOW) {
            recordMartingaleResult(false, positionKey(conditionId, asset), paper);
        }
    }
    return getMartingaleConsecutiveLosses(paper);
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

/** Overwrite streak (used when rebuilding paper circle from the ledger). */
export const setMartingaleStreak = (
    consecutiveLosses: number,
    processedKeys: string[],
    paper = ENV.PAPER_MODE
): void => {
    saveSlot(paper, {
        consecutiveLosses: Math.max(0, Math.floor(consecutiveLosses)),
        processedKeys: processedKeys.map((k) => k.toLowerCase()).slice(-MAX_PROCESSED),
        updatedAt: Math.floor(Date.now() / 1000),
    });
};

const isResolvedWin = (price: number): boolean => price >= RESOLVED_HIGH;
const isResolvedLoss = (price: number): boolean => price <= RESOLVED_LOW;

/**
 * Rebuild paper martingale streak from entered paper BUY signals + mark prices.
 * Ignores still-open markets; streak = trailing losses after the last resolved win.
 */
export const rebuildMartingaleFromResolvedMarks = (
    rowsOldestFirst: Array<{ conditionId: string; asset: string; curPrice: number }>,
    paper = true
): number => {
    const outcomes: Array<{ won: boolean; key: string }> = [];
    const seen = new Set<string>();

    for (const row of rowsOldestFirst) {
        const key = positionKey(row.conditionId, row.asset);
        if (!row.conditionId || !row.asset || seen.has(key)) continue;
        const price = Number(row.curPrice);
        if (!Number.isFinite(price)) continue;
        if (isResolvedWin(price)) {
            seen.add(key);
            outcomes.push({ won: true, key });
        } else if (isResolvedLoss(price)) {
            seen.add(key);
            outcomes.push({ won: false, key });
        }
    }

    const streak = trailingLossStreak(outcomes);
    setMartingaleStreak(
        streak,
        outcomes.map((o) => o.key),
        paper
    );
    return streak;
};
