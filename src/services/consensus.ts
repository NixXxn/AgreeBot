import { UserActivityInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import Logger from '../utils/logger';
import { recordBotSignal } from './botSignals';

export interface TradeWithUser extends UserActivityInterface {
    userAddress: string;
}

export type ConsensusSizeMode = 'AVERAGE' | 'LARGEST' | 'FIRST' | 'MEDIAN';

export interface ConsensusGroup {
    key: string;
    conditionId: string;
    asset: string;
    side: string;
    outcome?: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    traderAddresses: Set<string>;
    firstTradeTime: number;
    lastTradeTime: number;
}

export interface ConsensusReadyTrade {
    /** Synthetic trade used for order sizing / market identity */
    trade: TradeWithUser;
    /** All contributing trades (to mark processed) */
    contributingTrades: TradeWithUser[];
    /** Unique traders who agreed */
    agreeingTraders: string[];
    /** Reference trader for balance/position ratio */
    referenceTrader: string;
    /** Trader who tipped consensus to the threshold (last unique joiner) */
    lastAgreeingTrader: string;
    /** That trader's buy/sell price — used for slippage checks */
    lastAgreeingPrice: number;
}

const consensusBuffer: Map<string, ConsensusGroup> = new Map();

/**
 * Agreement key: same market outcome (asset) + side = traders "agree"
 */
export const getConsensusKey = (trade: TradeWithUser): string => {
    return `${trade.conditionId}:${trade.asset}:${(trade.side || 'BUY').toUpperCase()}`;
};

export const getConsensusBufferSize = (): number => consensusBuffer.size;

export const getConsensusStatus = (): Array<{
    key: string;
    traders: number;
    required: number;
    side: string;
    slug?: string;
    ageSeconds: number;
}> => {
    const now = Date.now();
    return Array.from(consensusBuffer.values()).map((g) => ({
        key: g.key,
        traders: g.traderAddresses.size,
        required: ENV.CONSENSUS_MIN_AGREEMENT,
        side: g.side,
        slug: g.slug || g.eventSlug,
        ageSeconds: Math.floor((now - g.firstTradeTime) / 1000),
    }));
};

const computeSizedUsdc = (trades: TradeWithUser[], mode: ConsensusSizeMode): number => {
    const sizes = trades.map((t) => t.usdcSize).filter((s) => s > 0);
    if (sizes.length === 0) return 0;

    switch (mode) {
        case 'LARGEST':
            return Math.max(...sizes);
        case 'FIRST':
            return sizes[0];
        case 'MEDIAN': {
            const sorted = [...sizes].sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            return sorted.length % 2 === 0
                ? (sorted[mid - 1] + sorted[mid]) / 2
                : sorted[mid];
        }
        case 'AVERAGE':
        default:
            return sizes.reduce((a, b) => a + b, 0) / sizes.length;
    }
};

const weightedAveragePrice = (trades: TradeWithUser[]): number => {
    const total = trades.reduce((sum, t) => sum + t.usdcSize, 0);
    if (total <= 0) return trades[0]?.price || 0;
    return trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0) / total;
};

/**
 * Add a trade to the consensus buffer. Returns true if added.
 */
export const addToConsensusBuffer = (trade: TradeWithUser): void => {
    const key = getConsensusKey(trade);
    const existing = consensusBuffer.get(key);
    const now = Date.now();
    const addr = trade.userAddress.toLowerCase();

    if (existing) {
        // Avoid duplicate DB docs
        if (existing.trades.some((t) => String(t._id) === String(trade._id))) {
            return;
        }
        existing.trades.push(trade);
        existing.traderAddresses.add(addr);
        existing.lastTradeTime = now;
        if (!existing.slug && trade.slug) existing.slug = trade.slug;
        if (!existing.eventSlug && trade.eventSlug) existing.eventSlug = trade.eventSlug;
        if (!existing.outcome && trade.outcome) existing.outcome = trade.outcome;

        Logger.info(
            `Consensus [${existing.traderAddresses.size}/${ENV.CONSENSUS_MIN_AGREEMENT}] ` +
                `${trade.side} ${trade.outcome || trade.asset.slice(0, 10)}… ` +
                `(${trade.userAddress.slice(0, 6)}…${trade.userAddress.slice(-4)}) ` +
                `on ${trade.slug || trade.eventSlug || 'market'}`
        );
    } else {
        consensusBuffer.set(key, {
            key,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: (trade.side || 'BUY').toUpperCase(),
            outcome: trade.outcome,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            traderAddresses: new Set([addr]),
            firstTradeTime: now,
            lastTradeTime: now,
        });

        Logger.info(
            `Consensus started [1/${ENV.CONSENSUS_MIN_AGREEMENT}] ` +
                `${trade.side} ${trade.outcome || trade.asset.slice(0, 10)}… ` +
                `waiting up to ${ENV.CONSENSUS_WINDOW_SECONDS}s for agreement`
        );
    }
};

/**
 * Mark trades as processed/skipped so they won't be re-read.
 */
const markTradesProcessed = async (
    trades: TradeWithUser[],
    opts: { bot: boolean; botExcutedTime: number }
): Promise<void> => {
    for (const trade of trades) {
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne(
            { _id: trade._id },
            { $set: { bot: opts.bot, botExcutedTime: opts.botExcutedTime } }
        ).exec();
    }
};

/**
 * Build a ready consensus trade from a group that met the threshold.
 */
const buildReadyTrade = (group: ConsensusGroup): ConsensusReadyTrade => {
    // One trade per unique trader (keep largest usdc if duplicates)
    const byTrader = new Map<string, TradeWithUser>();
    // Order traders by when they first joined the group (last tipper = last agreeing)
    const joinOrder: string[] = [];
    const firstJoinTrade = new Map<string, TradeWithUser>();
    for (const t of group.trades) {
        const addr = t.userAddress.toLowerCase();
        if (!firstJoinTrade.has(addr)) {
            firstJoinTrade.set(addr, t);
            joinOrder.push(addr);
        }
        const prev = byTrader.get(addr);
        if (!prev || t.usdcSize > prev.usdcSize) {
            byTrader.set(addr, t);
        }
    }
    const uniqueTrades = Array.from(byTrader.values());
    const sizedUsdc = computeSizedUsdc(uniqueTrades, ENV.CONSENSUS_SIZE_MODE as ConsensusSizeMode);
    const avgPrice = weightedAveragePrice(uniqueTrades);

    // Prefer largest trader as balance/position reference
    const reference = uniqueTrades.reduce((best, t) =>
        t.usdcSize > best.usdcSize ? t : best
    );

    const lastAgreeingTrader = joinOrder[joinOrder.length - 1] || reference.userAddress.toLowerCase();
    // Prefer the fill that first counted them toward consensus; fall back to largest
    const lastAgreeingTrade =
        firstJoinTrade.get(lastAgreeingTrader) || byTrader.get(lastAgreeingTrader) || reference;
    const lastAgreeingPrice = Number(lastAgreeingTrade.price) || avgPrice;

    const synthetic: TradeWithUser = {
        ...reference,
        usdcSize: sizedUsdc,
        price: avgPrice,
        side: group.side as 'BUY' | 'SELL',
        userAddress: reference.userAddress,
    };

    return {
        trade: synthetic,
        contributingTrades: group.trades,
        agreeingTraders: Array.from(group.traderAddresses),
        referenceTrader: reference.userAddress,
        lastAgreeingTrader,
        lastAgreeingPrice,
    };
};

/**
 * Evaluate buffer:
 * - Groups that reach min unique traders → ready immediately
 * - Groups whose window expired without enough traders → skip/discard
 */
export const evaluateConsensusBuffer = async (): Promise<{
    ready: ConsensusReadyTrade[];
    expiredCount: number;
}> => {
    const ready: ConsensusReadyTrade[] = [];
    let expiredCount = 0;
    const now = Date.now();
    const windowMs = ENV.CONSENSUS_WINDOW_SECONDS * 1000;
    const minAgreement = ENV.CONSENSUS_MIN_AGREEMENT;

    for (const [key, group] of consensusBuffer.entries()) {
        const uniqueCount = group.traderAddresses.size;
        const elapsed = now - group.firstTradeTime;

        if (uniqueCount >= minAgreement) {
            const readyTrade = buildReadyTrade(group);
            ready.push(readyTrade);
            consensusBuffer.delete(key);

            Logger.success(
                `Consensus reached! ${uniqueCount} traders agree on ` +
                    `${group.side} ${group.outcome || ''} ` +
                    `(${group.slug || group.eventSlug || group.asset.slice(0, 12)}…)`
            );
            Logger.info(
                `Agreeing: ${readyTrade.agreeingTraders
                    .map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`)
                    .join(', ')} | sized $${readyTrade.trade.usdcSize.toFixed(2)} (${ENV.CONSENSUS_SIZE_MODE})`
            );
            continue;
        }

        if (elapsed >= windowMs) {
            Logger.warning(
                `Consensus expired [${uniqueCount}/${minAgreement}] for ` +
                    `${group.side} ${group.outcome || group.slug || 'market'} — skipping`
            );
            await markTradesProcessed(group.trades, { bot: true, botExcutedTime: 999 });

            const ref = group.trades[0];
            const avgPrice =
                group.trades.reduce((s, t) => s + t.price * t.usdcSize, 0) /
                    Math.max(
                        group.trades.reduce((s, t) => s + t.usdcSize, 0),
                        1e-9
                    ) ||
                ref?.price ||
                0;

            await recordBotSignal({
                conditionId: group.conditionId,
                asset: group.asset,
                side: (group.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
                title: ref?.title,
                slug: group.slug || ref?.slug,
                eventSlug: group.eventSlug || ref?.eventSlug,
                outcome: group.outcome || ref?.outcome,
                entryPrice: avgPrice,
                sizeUsd: 0,
                agreementCount: uniqueCount,
                agreeingTraders: Array.from(group.traderAddresses),
                entered: false,
                reason: 'consensus_expired',
                minAgreement,
                paper: ENV.PAPER_MODE,
            });

            consensusBuffer.delete(key);
            expiredCount++;
        }
    }

    return { ready, expiredCount };
};

/**
 * Whether this trade side should go through consensus.
 */
export const shouldUseConsensus = (side: string | undefined): boolean => {
    if (!ENV.CONSENSUS_ENABLED) return false;
    const applyTo = (ENV.CONSENSUS_APPLY_TO || 'BUY').toUpperCase();
    const normalized = (side || 'BUY').toUpperCase();
    if (applyTo === 'BOTH') return true;
    return normalized === applyTo;
};
