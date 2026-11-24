/**
 * Paper-mode martingale: rebuild the recovery circle from bot_signals + CLOB marks.
 * Auto-resolver is live-only, and live wallet positions must not drive the paper circle.
 *
 * Rules:
 * - Only confirmed resolved marks (price in (0, 0.01] or [0.99, 1]) update the circle.
 * - Mid/last-trade of 0 is treated as unknown (empty book), never as a loss.
 * - While any entered paper BUY is still open, the next martingale entry is blocked
 *   (classic: one bet at a time — no escalate before the previous resolves).
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

export interface MartingaleSyncResult extends MartingaleCircle {
    /** Stake USD still open (unresolved) — next entry should wait. */
    pendingOpenUsd: number;
    pendingOpenCount: number;
}

let lastSyncAt = 0;
let lastResult: MartingaleSyncResult | null = null;
let inFlight: Promise<MartingaleSyncResult> | null = null;

const emptyResult = (): MartingaleSyncResult => ({
    ...getMartingaleCircle(true),
    pendingOpenUsd: 0,
    pendingOpenCount: 0,
});

/** Valid mark: finite and strictly > 0 (reject empty-book zeros). */
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

/** Prefer Gamma when the market is closed — avoids false loss from empty CLOB books. */
const fetchGammaResolvedPrice = async (
    conditionId: string,
    tokenId: string
): Promise<number | null> => {
    if (!conditionId) return null;
    try {
        const url = `https://gamma-api.polymarket.com/markets?condition_ids=${encodeURIComponent(conditionId)}`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const markets = (await res.json()) as Array<Record<string, unknown>>;
        if (!Array.isArray(markets) || markets.length === 0) return null;

        const parseArr = (raw: unknown): string[] => {
            if (Array.isArray(raw)) return raw.map(String);
            if (typeof raw === 'string') {
                try {
                    const p = JSON.parse(raw);
                    if (Array.isArray(p)) return p.map(String);
                } catch {
                    return raw.split(',').map((s) => s.trim()).filter(Boolean);
                }
            }
            return [];
        };

        const market =
            markets.find((m) => parseArr(m.clobTokenIds ?? m.clob_token_ids).includes(tokenId)) ||
            markets[0];
        const closed = Boolean(market.closed || market.resolved || market.active === false);
        if (!closed) return null;

        const tokens = parseArr(market.clobTokenIds ?? market.clob_token_ids);
        const prices = parseArr(market.outcomePrices ?? market.outcome_prices).map(Number);
        const idx = tokens.indexOf(tokenId);
        if (idx < 0 || !Number.isFinite(prices[idx]) || prices[idx] < 0) return null;
        const p = prices[idx];
        // Closed market with a zero price is a real loss
        return p;
    } catch {
        return null;
    }
};

const classifyMark = (
    price: number | null
): 'win' | 'loss' | 'open' => {
    if (price == null || !Number.isFinite(price)) return 'open';
    if (price >= RESOLVED_HIGH) return 'win';
    // Loss only for a positive tiny price (or exact 0 from Gamma closed)
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

/**
 * Rebuild paper consecutive-loss streak + cumulative lost USD from resolved ledger entries.
 * Throttled so consensus bursts don't hammer the CLOB.
 */
export const syncPaperMartingaleFromLedger = async (): Promise<MartingaleSyncResult> => {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_MIN_MS && lastResult && !inFlight) {
        return lastResult;
    }
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
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
            }> = [];
            const seen = new Set<string>();
            for (const s of signals) {
                const conditionId = String(s.conditionId || '');
                const asset = String(s.asset || '');
                if (!conditionId || !asset) continue;
                const key = positionKey(conditionId, asset);
                const sizeUsd = Math.max(0, Number(s.sizeUsd) || 0);
                if (seen.has(key)) {
                    const existing = unique.find((u) => u.key === key);
                    if (existing) existing.sizeUsd += sizeUsd;
                    continue;
                }
                seen.add(key);
                unique.push({ conditionId, asset, key, sizeUsd });
            }

            if (unique.length === 0) {
                const result: MartingaleSyncResult = {
                    consecutiveLosses: 0,
                    cumulativeLossUsd: 0,
                    pendingOpenUsd: 0,
                    pendingOpenCount: 0,
                };
                // Clear stale circle when ledger is empty
                rebuildMartingaleFromResolvedMarks([], true);
                lastResult = result;
                lastSyncAt = Date.now();
                return result;
            }

            const prices = await mapPool(unique, FETCH_CONCURRENCY, async (row) => {
                const gamma = await fetchGammaResolvedPrice(row.conditionId, row.asset);
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

            for (let i = 0; i < unique.length; i++) {
                const price = prices[i];
                const status = classifyMark(price);
                if (status === 'open') {
                    pendingOpenCount++;
                    pendingOpenUsd += unique[i].sizeUsd;
                    continue;
                }
                // Realized win/loss — for loss, price may be 0 from Gamma
                resolvedRows.push({
                    conditionId: unique[i].conditionId,
                    asset: unique[i].asset,
                    curPrice: status === 'win' ? 1 : price != null && price > 0 ? price : 0,
                    sizeUsd: unique[i].sizeUsd,
                });
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
                    `resolved=${resolvedRows.length}`
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
