/**
 * Paper-mode martingale: rebuild the recovery circle from bot_signals + CLOB marks.
 *
 * Rules:
 * - Only confirmed resolved marks update the circle.
 * - Mid/last-trade of 0 is unknown (empty book), never a loss — prefer Gamma.
 * - One open bet at a time: block only while a *recent* paper BUY is still open
 *   (stale "open" from failed price fetches must not freeze trading forever).
 */
import { BotSignal } from '../models/botSignal';
import {
    getMartingaleCircle,
    MartingaleCircle,
    positionKey,
    rebuildMartingaleFromResolvedMarks,
} from './martingaleState';

const RESOLVED_HIGH = 0.99;
const RESOLVED_LOW = 0.01;
const SYNC_MIN_MS = 8_000;
const FETCH_CONCURRENCY = 8;
/** 5m crypto windows + buffer — older "open" rows never block the next entry. */
const PENDING_MAX_AGE_SEC = 12 * 60;

export interface MartingaleSyncResult extends MartingaleCircle {
    /** Stake USD still open (unresolved) — next entry should wait. */
    pendingOpenUsd: number;
    pendingOpenCount: number;
}

let lastSyncAt = 0;
let lastResult: MartingaleSyncResult | null = null;
let inFlight: Promise<MartingaleSyncResult> | null = null;

/** In-memory lock so we don't double-enter before the fill is in Mongo + marked open. */
let localAwaiting: { key: string; sizeUsd: number; enteredAtMs: number } | null = null;

const emptyResult = (): MartingaleSyncResult => ({
    ...getMartingaleCircle(true),
    pendingOpenUsd: 0,
    pendingOpenCount: 0,
});

/** Call after a paper martingale BUY fill so the next consensus waits for settle. */
export const notePaperMartingaleEntry = (
    conditionId: string,
    asset: string,
    sizeUsd: number
): void => {
    if (!conditionId || !asset || !(sizeUsd > 0)) return;
    localAwaiting = {
        key: positionKey(conditionId, asset),
        sizeUsd,
        enteredAtMs: Date.now(),
    };
    // Invalidate throttle so the next size call sees pending immediately
    lastSyncAt = 0;
    if (lastResult) {
        lastResult = {
            ...lastResult,
            pendingOpenCount: Math.max(1, lastResult.pendingOpenCount),
            pendingOpenUsd: Math.max(sizeUsd, lastResult.pendingOpenUsd),
        };
    }
};

const parsePositivePrice = (raw: unknown): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
};

const fetchMarkPrice = async (tokenId: string): Promise<number | null> => {
    if (!tokenId) return null;
    try {
        const midUrl = `https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(tokenId)}`;
        const midRes = await fetch(midUrl);
        if (midRes.ok) {
            const data = (await midRes.json()) as { mid?: unknown; price?: unknown };
            const mid = parsePositivePrice(data?.mid ?? data?.price);
            if (mid != null) return mid;
        }
    } catch {
        /* fall through */
    }
    try {
        const lastUrl = `https://clob.polymarket.com/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
        const lastRes = await fetch(lastUrl);
        if (lastRes.ok) {
            const data = (await lastRes.json()) as { price?: unknown; last_trade_price?: unknown };
            const price = parsePositivePrice(data?.price ?? data?.last_trade_price);
            if (price != null) return price;
        }
    } catch {
        /* ignore */
    }
    return null;
};

const parseArr = (raw: unknown): string[] => {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const p = JSON.parse(raw);
            if (Array.isArray(p)) return p.map(String);
        } catch {
            return raw
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
    }
    return [];
};

/**
 * Gamma mark for a token. If `forceExtreme` (aged market), accept 0/1 even when
 * `closed` is not yet flipped — otherwise require closed/resolved.
 */
const fetchGammaPrice = async (
    conditionId: string,
    tokenId: string,
    forceExtreme: boolean
): Promise<number | null> => {
    if (!conditionId) return null;
    try {
        const url = `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const markets = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(markets) || markets.length === 0) return null;

        const market =
            markets.find((m) => parseArr(m.clobTokenIds ?? m.clob_token_ids).includes(tokenId)) ||
            markets[0];
        const closed = Boolean(market.closed || market.resolved || market.active === false);
        const tokens = parseArr(market.clobTokenIds ?? market.clob_token_ids);
        const prices = parseArr(market.outcomePrices ?? market.outcome_prices).map(Number);
        const idx = tokens.indexOf(tokenId);
        if (idx < 0 || !Number.isFinite(prices[idx]) || prices[idx] < 0) return null;
        const p = prices[idx];
        const extreme = p <= RESOLVED_LOW || p >= RESOLVED_HIGH;
        if (closed) return p;
        if (forceExtreme && extreme) return p;
        return null;
    } catch {
        return null;
    }
};

const classifyMark = (price: number | null): 'win' | 'loss' | 'open' => {
    if (price == null || !Number.isFinite(price)) return 'open';
    if (price >= RESOLVED_HIGH) return 'win';
    if (price >= 0 && price <= RESOLVED_LOW) return 'loss';
    return 'open';
};

const mapPool = async <T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> => {
    const results: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
};

export const syncPaperMartingaleFromLedger = async (): Promise<MartingaleSyncResult> => {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_MIN_MS && lastResult && !inFlight) {
        return lastResult;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            const nowSec = Math.floor(Date.now() / 1000);
            const signals = await BotSignal.find({
                entered: true,
                paper: true,
                side: { $in: ['BUY', 'buy'] },
            })
                .sort({ createdAt: 1 })
                .select({ conditionId: 1, asset: 1, createdAt: 1, sizeUsd: 1 })
                .lean()
                .exec();

            const unique: Array<{
                conditionId: string;
                asset: string;
                key: string;
                sizeUsd: number;
                createdAt: number;
            }> = [];
            const seen = new Set<string>();
            for (const s of signals) {
                const conditionId = String(s.conditionId || '');
                const asset = String(s.asset || '');
                if (!conditionId || !asset) continue;
                const key = positionKey(conditionId, asset);
                const sizeUsd = Math.max(0, Number(s.sizeUsd) || 0);
                const createdAt = Number(s.createdAt) || 0;
                if (seen.has(key)) {
                    const existing = unique.find((u) => u.key === key);
                    if (existing) existing.sizeUsd += sizeUsd;
                    continue;
                }
                seen.add(key);
                unique.push({ conditionId, asset, key, sizeUsd, createdAt });
            }

            if (unique.length === 0) {
                localAwaiting = null;
                const result: MartingaleSyncResult = {
                    consecutiveLosses: 0,
                    cumulativeLossUsd: 0,
                    pendingOpenUsd: 0,
                    pendingOpenCount: 0,
                };
                rebuildMartingaleFromResolvedMarks([], true);
                lastResult = result;
                lastSyncAt = Date.now();
                return result;
            }

            const prices = await mapPool(unique, FETCH_CONCURRENCY, async (row) => {
                const ageSec = row.createdAt > 0 ? nowSec - row.createdAt : PENDING_MAX_AGE_SEC + 1;
                const forceExtreme = ageSec > 6 * 60;
                const gamma = await fetchGammaPrice(row.conditionId, row.asset, forceExtreme);
                if (gamma != null) return gamma;
                return fetchMarkPrice(row.asset);
            });

            const resolvedRows: Array<{
                conditionId: string;
                asset: string;
                curPrice: number;
                sizeUsd: number;
            }> = [];
            let pendingOpenUsd = 0;
            let pendingOpenCount = 0;
            let staleOpenCount = 0;

            for (let i = 0; i < unique.length; i++) {
                const price = prices[i];
                const status = classifyMark(price);
                const ageSec =
                    unique[i].createdAt > 0 ? nowSec - unique[i].createdAt : PENDING_MAX_AGE_SEC + 1;

                if (status === 'open') {
                    // Only recent opens block the next entry
                    if (ageSec >= 0 && ageSec <= PENDING_MAX_AGE_SEC) {
                        pendingOpenCount++;
                        pendingOpenUsd += unique[i].sizeUsd;
                    } else {
                        staleOpenCount++;
                    }
                    continue;
                }

                if (localAwaiting && localAwaiting.key === unique[i].key) {
                    localAwaiting = null;
                }

                resolvedRows.push({
                    conditionId: unique[i].conditionId,
                    asset: unique[i].asset,
                    curPrice: status === 'win' ? 1 : price != null && price > 0 ? price : 0,
                    sizeUsd: unique[i].sizeUsd,
                });
            }

            // Local fill not yet visible as open/resolved in ledger
            if (localAwaiting) {
                const ageMs = Date.now() - localAwaiting.enteredAtMs;
                if (ageMs > PENDING_MAX_AGE_SEC * 1000) {
                    localAwaiting = null;
                } else if (pendingOpenCount === 0) {
                    pendingOpenCount = 1;
                    pendingOpenUsd = localAwaiting.sizeUsd;
                }
            }

            const circle = rebuildMartingaleFromResolvedMarks(resolvedRows, true);
            const result: MartingaleSyncResult = {
                ...circle,
                pendingOpenUsd,
                pendingOpenCount,
            };
            console.log(
                `🎲 Paper martingale rebuild: streak=${circle.consecutiveLosses} ` +
                    `recover=$${circle.cumulativeLossUsd.toFixed(2)} ` +
                    `pending=${pendingOpenCount} ($${pendingOpenUsd.toFixed(2)}) ` +
                    `resolved=${resolvedRows.length}` +
                    (staleOpenCount > 0 ? ` staleOpen=${staleOpenCount}` : '')
            );
            lastResult = result;
            lastSyncAt = Date.now();
            return result;
        } catch (error) {
            console.warn(
                `Paper martingale sync failed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            return lastResult ?? emptyResult();
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
};
