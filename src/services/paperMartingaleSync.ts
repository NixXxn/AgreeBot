/**
 * Paper-mode martingale: rebuild the recovery circle from bot_signals + CLOB marks.
 * Auto-resolver is live-only, and live wallet positions must not drive the paper circle.
 *
 * Resolution quality (from e359725):
 * - Mid/last-trade of 0 is unknown (empty book), never a loss
 * - Prefer Gamma; for aged entries accept extreme 0/1 even before `closed` flips
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
const SYNC_MIN_MS = 12_000;
const FETCH_CONCURRENCY = 8;

let lastSyncAt = 0;
let inFlight: Promise<MartingaleCircle> | null = null;

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

/**
 * Rebuild paper consecutive-loss streak + cumulative lost USD from resolved ledger entries.
 * Throttled so consensus bursts don't hammer the CLOB.
 * Open/unresolved rows are omitted from the circle (no entry gate).
 */
export const syncPaperMartingaleFromLedger = async (): Promise<MartingaleCircle> => {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_MIN_MS && !inFlight) {
        return getMartingaleCircle(true);
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
                rebuildMartingaleFromResolvedMarks([], true);
                lastSyncAt = Date.now();
                return getMartingaleCircle(true);
            }

            const prices = await mapPool(unique, FETCH_CONCURRENCY, async (row) => {
                const ageSec = row.createdAt > 0 ? nowSec - row.createdAt : 0;
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
            let openCount = 0;
            for (let i = 0; i < unique.length; i++) {
                const price = prices[i];
                const status = classifyMark(price);
                if (status === 'open') {
                    openCount++;
                    continue;
                }
                resolvedRows.push({
                    conditionId: unique[i].conditionId,
                    asset: unique[i].asset,
                    curPrice: status === 'win' ? 1 : price != null && price > 0 ? price : 0,
                    sizeUsd: unique[i].sizeUsd,
                });
            }

            const circle = rebuildMartingaleFromResolvedMarks(resolvedRows, true);
            console.log(
                `🎲 Paper martingale rebuild: streak=${circle.consecutiveLosses} ` +
                    `recover=$${circle.cumulativeLossUsd.toFixed(2)} ` +
                    `(resolved ${resolvedRows.length}, open/unknown ${openCount})`
            );
            lastSyncAt = Date.now();
            return circle;
        } catch (error) {
            console.warn(
                `Paper martingale sync failed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            return getMartingaleCircle(true);
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
};
