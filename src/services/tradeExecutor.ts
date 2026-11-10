import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import { fetchUserPositions } from '../utils/polymarketData';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';
import Logger from '../utils/logger';
import {
    TradeWithUser,
    ConsensusReadyTrade,
    addToConsensusBuffer,
    evaluateConsensusBuffer,
    shouldUseConsensus,
    getConsensusBufferSize,
} from './consensus';
import { recordBotSignal } from './botSignals';
import { ensureClobClient } from './clobClientHolder';

const PROXY_WALLET = ENV.PROXY_WALLET;
const TRADE_AGGREGATION_MIN_TOTAL_USD = 1.0; // Polymarket minimum

const getUserAddresses = () => ENV.USER_ADDRESSES;

const getUserActivityModels = () =>
    getUserAddresses().map((address) => ({
        address,
        model: getUserActivityModel(address),
    }));

interface AggregatedTrade {
    userAddress: string;
    conditionId: string;
    asset: string;
    side: string;
    slug?: string;
    eventSlug?: string;
    trades: TradeWithUser[];
    totalUsdcSize: number;
    averagePrice: number;
    firstTradeTime: number;
    lastTradeTime: number;
}

// Buffer for aggregating trades
const tradeAggregationBuffer: Map<string, AggregatedTrade> = new Map();

const readTempTrades = async (): Promise<TradeWithUser[]> => {
    const allTrades: TradeWithUser[] = [];

    for (const { address, model } of getUserActivityModels()) {
        // Only get trades that haven't been processed yet (bot: false AND botExcutedTime: 0)
        // This prevents processing the same trade multiple times
        const trades = await model
            .find({
                $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: 0 }],
            })
            .exec();

        const tradesWithUser = trades.map((trade) => ({
            ...(trade.toObject() as UserActivityInterface),
            userAddress: address,
        }));

        allTrades.push(...tradesWithUser);
    }

    return allTrades;
};

/**
 * Generate a unique key for trade aggregation based on user, market, side
 */
const getAggregationKey = (trade: TradeWithUser): string => {
    return `${trade.userAddress}:${trade.conditionId}:${trade.asset}:${trade.side}`;
};

/**
 * Add trade to aggregation buffer or update existing aggregation
 */
const addToAggregationBuffer = (trade: TradeWithUser): void => {
    const key = getAggregationKey(trade);
    const existing = tradeAggregationBuffer.get(key);
    const now = Date.now();

    if (existing) {
        // Update existing aggregation
        existing.trades.push(trade);
        existing.totalUsdcSize += trade.usdcSize;
        // Recalculate weighted average price
        const totalValue = existing.trades.reduce((sum, t) => sum + t.usdcSize * t.price, 0);
        existing.averagePrice = totalValue / existing.totalUsdcSize;
        existing.lastTradeTime = now;
    } else {
        // Create new aggregation
        tradeAggregationBuffer.set(key, {
            userAddress: trade.userAddress,
            conditionId: trade.conditionId,
            asset: trade.asset,
            side: trade.side || 'BUY',
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            trades: [trade],
            totalUsdcSize: trade.usdcSize,
            averagePrice: trade.price,
            firstTradeTime: now,
            lastTradeTime: now,
        });
    }
};

/**
 * Check buffer and return ready aggregated trades
 * Trades are ready if:
 * 1. Total size >= minimum AND
 * 2. Time window has passed since first trade
 */
const getReadyAggregatedTrades = (): AggregatedTrade[] => {
    const ready: AggregatedTrade[] = [];
    const now = Date.now();
    const windowMs = ENV.TRADE_AGGREGATION_WINDOW_SECONDS * 1000;

    for (const [key, agg] of tradeAggregationBuffer.entries()) {
        const timeElapsed = now - agg.firstTradeTime;

        // Check if aggregation is ready
        if (timeElapsed >= windowMs) {
            if (agg.totalUsdcSize >= TRADE_AGGREGATION_MIN_TOTAL_USD) {
                // Aggregation meets minimum and window passed - ready to execute
                ready.push(agg);
            } else {
                // Window passed but total too small - mark individual trades as skipped
                Logger.info(
                    `Trade aggregation for ${agg.userAddress} on ${agg.slug || agg.asset}: $${agg.totalUsdcSize.toFixed(2)} total from ${agg.trades.length} trades below minimum ($${TRADE_AGGREGATION_MIN_TOTAL_USD}) - skipping`
                );

                // Mark all trades in this aggregation as processed (bot: true)
                for (const trade of agg.trades) {
                    const UserActivity = getUserActivityModel(trade.userAddress);
                    UserActivity.updateOne({ _id: trade._id }, { bot: true }).exec();
                }
            }
            // Remove from buffer either way
            tradeAggregationBuffer.delete(key);
        }
    }

    return ready;
};

const doTrading = async (clobClient: ClobClient | null, trades: TradeWithUser[]) => {
    for (const trade of trades) {
        // Mark trade as being processed immediately to prevent duplicate processing
        const UserActivity = getUserActivityModel(trade.userAddress);
        await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });

        Logger.trade(trade.userAddress, trade.side || 'UNKNOWN', {
            asset: trade.asset,
            side: trade.side,
            amount: trade.usdcSize,
            price: trade.price,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            transactionHash: trade.transactionHash,
        });

        const user_positions = (await fetchUserPositions(
            trade.userAddress
        )) as UserPositionInterface[];
        const user_position = user_positions.find(
            (position) => position.conditionId === trade.conditionId
        );

        let my_position: UserPositionInterface | undefined;
        let my_balance = 0;
        if (PROXY_WALLET) {
            const my_positions = (await fetchUserPositions(PROXY_WALLET)) as UserPositionInterface[];
            my_position = my_positions.find(
                (position) => position.conditionId === trade.conditionId
            );
            my_balance = await getMyBalance(PROXY_WALLET);
        }

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        if (PROXY_WALLET) {
            Logger.balance(my_balance, user_balance, trade.userAddress);
        }

        // Execute the trade (or paper-log)
        const orderResult = await postOrder(
            clobClient,
            trade.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            trade,
            my_balance,
            user_balance,
            trade.userAddress
        );

        const side = (trade.side || 'BUY').toUpperCase() as 'BUY' | 'SELL';
        // Only count a fill when postOrder confirms execution (never assume success)
        const executed = orderResult.executed === true;
        await recordBotSignal({
            conditionId: trade.conditionId,
            asset: trade.asset,
            side,
            title: trade.title,
            slug: trade.slug,
            eventSlug: trade.eventSlug,
            outcome: trade.outcome,
            entryPrice: trade.price,
            sizeUsd: executed ? orderResult.sizeUsd : 0,
            agreementCount: 1,
            agreeingTraders: [trade.userAddress],
            entered: executed,
            reason: executed
                ? 'copy'
                : side === 'SELL'
                  ? 'no_position'
                  : 'skipped',
            paper: orderResult.paper,
        });

        Logger.separator();
    }
};

/**
 * Execute a single consensus trade (one order after N traders agree).
 */
const doConsensusTrading = async (
    clobClient: ClobClient | null,
    readyList: ConsensusReadyTrade[]
) => {
    for (const ready of readyList) {
        Logger.header(
            `🤝 CONSENSUS TRADE (${ready.agreeingTraders.length} traders agree)`
        );
        Logger.info(`Market: ${ready.trade.slug || ready.trade.eventSlug || ready.trade.asset}`);
        Logger.info(`Outcome: ${ready.trade.outcome || 'n/a'} | Side: ${ready.trade.side}`);
        Logger.info(`Sized volume: $${ready.trade.usdcSize.toFixed(2)} (${ENV.CONSENSUS_SIZE_MODE})`);
        Logger.info(
            `Traders: ${ready.agreeingTraders.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(', ')}`
        );

        // Mark all contributing trades as being processed
        for (const trade of ready.contributingTrades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        const user_positions = (await fetchUserPositions(
            ready.referenceTrader
        )) as UserPositionInterface[];
        const user_position = user_positions.find(
            (position) => position.conditionId === ready.trade.conditionId
        );

        let my_position: UserPositionInterface | undefined;
        let my_balance = 0;
        if (PROXY_WALLET) {
            const my_positions = (await fetchUserPositions(PROXY_WALLET)) as UserPositionInterface[];
            my_position = my_positions.find(
                (position) => position.conditionId === ready.trade.conditionId
            );
            my_balance = await getMyBalance(PROXY_WALLET);
        }

        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        if (PROXY_WALLET) {
            Logger.balance(my_balance, user_balance, ready.referenceTrader);
        }

        const orderResult = await postOrder(
            clobClient,
            ready.trade.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            ready.trade,
            my_balance,
            user_balance,
            ready.referenceTrader
        );

        const executed = orderResult.executed === true;
        await recordBotSignal({
            conditionId: ready.trade.conditionId,
            asset: ready.trade.asset,
            side: (ready.trade.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
            title: ready.trade.title,
            slug: ready.trade.slug,
            eventSlug: ready.trade.eventSlug,
            outcome: ready.trade.outcome,
            entryPrice: ready.trade.price,
            sizeUsd: executed ? orderResult.sizeUsd : 0,
            agreementCount: ready.agreeingTraders.length,
            agreeingTraders: ready.agreeingTraders,
            entered: executed,
            reason: executed ? 'consensus' : 'skipped',
            minAgreement: ENV.CONSENSUS_MIN_AGREEMENT,
            paper: orderResult.paper,
        });

        // Mark contributing trades fully processed
        for (const trade of ready.contributingTrades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { bot: true } });
        }

        Logger.separator();
    }
};

/**
 * Execute aggregated trades
 */
const doAggregatedTrading = async (
    clobClient: ClobClient | null,
    aggregatedTrades: AggregatedTrade[]
) => {
    for (const agg of aggregatedTrades) {
        Logger.header(`📊 AGGREGATED TRADE (${agg.trades.length} trades combined)`);
        Logger.info(`Market: ${agg.slug || agg.asset}`);
        Logger.info(`Side: ${agg.side}`);
        Logger.info(`Total volume: $${agg.totalUsdcSize.toFixed(2)}`);
        Logger.info(`Average price: $${agg.averagePrice.toFixed(4)}`);

        // Mark all individual trades as being processed
        for (const trade of agg.trades) {
            const UserActivity = getUserActivityModel(trade.userAddress);
            await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
        }

        const user_positions = (await fetchUserPositions(
            agg.userAddress
        )) as UserPositionInterface[];
        const user_position = user_positions.find(
            (position) => position.conditionId === agg.conditionId
        );

        let my_position: UserPositionInterface | undefined;
        let my_balance = 0;
        if (PROXY_WALLET) {
            const my_positions = (await fetchUserPositions(PROXY_WALLET)) as UserPositionInterface[];
            my_position = my_positions.find(
                (position) => position.conditionId === agg.conditionId
            );
            my_balance = await getMyBalance(PROXY_WALLET);
        }

        // Calculate trader's total portfolio value from positions
        const user_balance = user_positions.reduce((total, pos) => {
            return total + (pos.currentValue || 0);
        }, 0);

        if (PROXY_WALLET) {
            Logger.balance(my_balance, user_balance, agg.userAddress);
        }

        // Create a synthetic trade object for postOrder using aggregated values
        const syntheticTrade: UserActivityInterface = {
            ...agg.trades[0], // Use first trade as template
            usdcSize: agg.totalUsdcSize,
            price: agg.averagePrice,
            side: agg.side as 'BUY' | 'SELL',
        };

        // Execute the aggregated trade (or paper-log)
        const orderResult = await postOrder(
            clobClient,
            agg.side === 'BUY' ? 'buy' : 'sell',
            my_position,
            user_position,
            syntheticTrade,
            my_balance,
            user_balance,
            agg.userAddress
        );

        const executed = orderResult.executed === true;
        await recordBotSignal({
            conditionId: agg.conditionId,
            asset: agg.asset,
            side: (agg.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
            title: agg.trades[0]?.title,
            slug: agg.slug,
            eventSlug: agg.eventSlug,
            outcome: agg.trades[0]?.outcome,
            entryPrice: agg.averagePrice,
            sizeUsd: executed ? orderResult.sizeUsd : 0,
            agreementCount: 1,
            agreeingTraders: [agg.userAddress],
            entered: executed,
            reason: executed ? 'aggregated' : 'skipped',
            paper: orderResult.paper,
        });

        Logger.separator();
    }
};

/**
 * Claim trades into consensus buffer immediately so they aren't re-read.
 * Sets botExcutedTime=1 while keeping bot=false until consensus resolves.
 */
const claimForConsensus = async (trade: TradeWithUser): Promise<void> => {
    const UserActivity = getUserActivityModel(trade.userAddress);
    await UserActivity.updateOne({ _id: trade._id }, { $set: { botExcutedTime: 1 } });
    addToConsensusBuffer({ ...trade, botExcutedTime: 1 });
};

// Track if executor should continue running
let isRunning = true;

/**
 * Stop the trade executor gracefully
 */
export const stopTradeExecutor = () => {
    isRunning = false;
    Logger.info('Trade executor shutdown requested...');
};

const tradeExecutor = async (_initialClient?: ClobClient | null) => {
    Logger.success(`Trade executor ready for ${getUserAddresses().length} trader(s)`);
    if (ENV.PAPER_MODE) {
        Logger.warning('PAPER MODE — signals logged only, no live orders');
    }
    if (ENV.CONSENSUS_ENABLED) {
        Logger.info(
            `Consensus mode ON: need ${ENV.CONSENSUS_MIN_AGREEMENT}+ traders to agree ` +
                `within ${ENV.CONSENSUS_WINDOW_SECONDS}s (apply to ${ENV.CONSENSUS_APPLY_TO}, size ${ENV.CONSENSUS_SIZE_MODE})`
        );
    }
    if (ENV.TRADE_AGGREGATION_ENABLED) {
        Logger.info(
            `Trade aggregation enabled: ${ENV.TRADE_AGGREGATION_WINDOW_SECONDS}s window, $${TRADE_AGGREGATION_MIN_TOTAL_USD} minimum`
        );
    }

    let lastCheck = Date.now();
    let lastModeWasPaper = ENV.PAPER_MODE;
    while (isRunning) {
        // Recreate CLOB client when Settings flips paper → live without restart
        if (ENV.PAPER_MODE !== lastModeWasPaper) {
            Logger.info(
                `Trading mode changed → ${ENV.PAPER_MODE ? 'paper' : 'live'}; refreshing CLOB client`
            );
            lastModeWasPaper = ENV.PAPER_MODE;
        }
        const clobClient = await ensureClobClient();

        const trades = await readTempTrades();

        // --- Consensus path ---
        if (ENV.CONSENSUS_ENABLED && trades.length > 0) {
            const consensusTrades: TradeWithUser[] = [];
            const immediateTrades: TradeWithUser[] = [];

            for (const trade of trades) {
                if (shouldUseConsensus(trade.side)) {
                    consensusTrades.push(trade);
                } else {
                    immediateTrades.push(trade);
                }
            }

            if (consensusTrades.length > 0) {
                Logger.clearLine();
                Logger.info(
                    `📥 ${consensusTrades.length} trade(s) queued for consensus ` +
                        `(need ${ENV.CONSENSUS_MIN_AGREEMENT} agreeing traders)`
                );
                for (const trade of consensusTrades) {
                    await claimForConsensus(trade);
                }
            }

            // Non-consensus sides (e.g. SELLs when APPLY_TO=BUY) execute normally
            if (immediateTrades.length > 0) {
                if (ENV.TRADE_AGGREGATION_ENABLED) {
                    for (const trade of immediateTrades) {
                        if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                            addToAggregationBuffer(trade);
                        } else {
                            await doTrading(clobClient, [trade]);
                        }
                    }
                } else {
                    await doTrading(clobClient, immediateTrades);
                }
            }

            lastCheck = Date.now();
        } else if (!ENV.CONSENSUS_ENABLED && ENV.TRADE_AGGREGATION_ENABLED) {
            // Process with aggregation logic (original)
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.info(
                    `📥 ${trades.length} new trade${trades.length > 1 ? 's' : ''} detected`
                );

                // Add trades to aggregation buffer
                for (const trade of trades) {
                    // Only aggregate BUY trades below minimum threshold
                    if (trade.side === 'BUY' && trade.usdcSize < TRADE_AGGREGATION_MIN_TOTAL_USD) {
                        Logger.info(
                            `Adding $${trade.usdcSize.toFixed(2)} ${trade.side} trade to aggregation buffer for ${trade.slug || trade.asset}`
                        );
                        addToAggregationBuffer(trade);
                    } else {
                        // Execute large trades immediately (not aggregated)
                        Logger.clearLine();
                        Logger.header(`⚡ IMMEDIATE TRADE (above threshold)`);
                        await doTrading(clobClient, [trade]);
                    }
                }
                lastCheck = Date.now();
            }
        } else if (!ENV.CONSENSUS_ENABLED) {
            // Original non-aggregation logic
            if (trades.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${trades.length} NEW TRADE${trades.length > 1 ? 'S' : ''} TO COPY`
                );
                await doTrading(clobClient, trades);
                lastCheck = Date.now();
            }
        }

        // Evaluate consensus buffer every loop
        if (ENV.CONSENSUS_ENABLED) {
            const { ready } = await evaluateConsensusBuffer();
            if (ready.length > 0) {
                Logger.clearLine();
                await doConsensusTrading(clobClient, ready);
                lastCheck = Date.now();
            }
        }

        // Check for ready aggregated trades
        if (ENV.TRADE_AGGREGATION_ENABLED) {
            const readyAggregations = getReadyAggregatedTrades();
            if (readyAggregations.length > 0) {
                Logger.clearLine();
                Logger.header(
                    `⚡ ${readyAggregations.length} AGGREGATED TRADE${readyAggregations.length > 1 ? 'S' : ''} READY`
                );
                await doAggregatedTrading(clobClient, readyAggregations);
                lastCheck = Date.now();
            }
        }

        // Waiting message
        if (Date.now() - lastCheck > 300) {
            const pendingParts: string[] = [];
            if (ENV.CONSENSUS_ENABLED) {
                const n = getConsensusBufferSize();
                if (n > 0) pendingParts.push(`${n} consensus group(s)`);
            }
            if (ENV.TRADE_AGGREGATION_ENABLED && tradeAggregationBuffer.size > 0) {
                pendingParts.push(`${tradeAggregationBuffer.size} aggregation(s)`);
            }
            const traderCount = getUserAddresses().length;
            if (pendingParts.length > 0) {
                Logger.waiting(traderCount, pendingParts.join(', '));
            } else {
                Logger.waiting(traderCount);
            }
            lastCheck = Date.now();
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    Logger.info('Trade executor stopped');
};

export default tradeExecutor;
