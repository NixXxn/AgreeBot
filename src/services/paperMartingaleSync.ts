/**
 * Paper-mode martingale: rebuild the loss streak from bot_signals + CLOB marks.
 * Auto-resolver is live-only, and live wallet positions must not drive the paper circle.
 */
import { BotSignal } from '../models/botSignal';
import {
    getMartingaleConsecutiveLosses,
    positionKey,
    rebuildMartingaleFromResolvedMarks,
} from './martingaleState';

const RESOLVED_HIGH = 0.99;
const RESOLVED_LOW = 0.01;
const SYNC_MIN_MS = 12_000;
const FETCH_CONCURRENCY = 8;

let lastSyncAt = 0;
let inFlight: Promise<number> | null = null;

const fetchMarkPrice = async (tokenId: string): Promise<number | null> => {
    if (!tokenId) return null;
    try {
        const midUrl = `https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(tokenId)}`;
        const midRes = await fetch(midUrl);
        if (midRes.ok) {
            const data = (await midRes.json()) as { mid?: unknown; price?: unknown };
            const mid = Number(data?.mid ?? data?.price);
            if (Number.isFinite(mid) && mid >= 0) return mid;
        }
    } catch {
        /* fall through */
    }
    try {
        const lastUrl = `https://clob.polymarket.com/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
        const lastRes = await fetch(lastUrl);
        if (lastRes.ok) {
            const data = (await lastRes.json()) as { price?: unknown; last_trade_price?: unknown };
            const price = Number(data?.price ?? data?.last_trade_price);
            if (Number.isFinite(price) && price >= 0) return price;
        }
    } catch {
        /* ignore */
    }
    return null;
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
 * Rebuild paper consecutive-loss streak from resolved paper ledger entries.
 * Throttled so consensus bursts don't hammer the CLOB.
 */
export const syncPaperMartingaleFromLedger = async (): Promise<number> => {
    const now = Date.now();
    if (now - lastSyncAt < SYNC_MIN_MS && !inFlight) {
        return getMartingaleConsecutiveLosses(true);
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
                .select({ conditionId: 1, asset: 1, createdAt: 1 })
                .lean()
                .exec();

            const unique: Array<{ conditionId: string; asset: string; key: string }> = [];
            const seen = new Set<string>();
            for (const s of signals) {
                const conditionId = String(s.conditionId || '');
                const asset = String(s.asset || '');
                if (!conditionId || !asset) continue;
                const key = positionKey(conditionId, asset);
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push({ conditionId, asset, key });
            }

            if (unique.length === 0) {
                return getMartingaleConsecutiveLosses(true);
            }

            const prices = await mapPool(unique, FETCH_CONCURRENCY, (row) =>
                fetchMarkPrice(row.asset)
            );

            const resolvedRows: Array<{
                conditionId: string;
                asset: string;
                curPrice: number;
            }> = [];
            let openCount = 0;
            for (let i = 0; i < unique.length; i++) {
                const price = prices[i];
                if (price == null || !Number.isFinite(price)) {
                    openCount++;
                    continue;
                }
                if (price > RESOLVED_LOW && price < RESOLVED_HIGH) {
                    openCount++;
                    continue;
                }
                resolvedRows.push({
                    conditionId: unique[i].conditionId,
                    asset: unique[i].asset,
                    curPrice: price,
                });
            }

            const streak = rebuildMartingaleFromResolvedMarks(resolvedRows, true);
            console.log(
                `🎲 Paper martingale rebuild: streak=${streak} ` +
                    `(resolved ${resolvedRows.length}, open/unknown ${openCount})`
            );
            lastSyncAt = Date.now();
            return streak;
        } catch (error) {
            console.warn(
                `Paper martingale sync failed: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
            return getMartingaleConsecutiveLosses(true);
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
};
