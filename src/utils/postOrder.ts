import { ClobClient, OrderType, Side } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import {
    calculateOrderSize,
    CopyStrategy,
    getTradeMultiplier,
} from '../config/copyStrategy';
import {
    applyPaperFill,
    getAllPaperPositions,
    getOppositePaperPosition,
    getPaperPosition,
    hasOpenPaperPosition,
} from '../services/paperPositions';
import {
    getMartingaleConsecutiveLosses,
    syncMartingaleFromPrices,
} from '../services/martingaleState';
import { syncPaperMartingaleFromLedger } from '../services/paperMartingaleSync';
import {
    ceilToTick,
    computeHedgeArbPlan,
    findOppositePosition,
    floorToTick,
} from './hedgeArb';
import {
    findEventFamilyPosition,
    findSameAssetPosition,
    isAverageDown,
    isCryptoUpDownMarket,
} from './entryGuards';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const COPY_STRATEGY_CONFIG = ENV.COPY_STRATEGY_CONFIG;

// Legacy parameters (for backward compatibility in SELL logic)
const TRADE_MULTIPLIER = ENV.TRADE_MULTIPLIER;
const COPY_PERCENTAGE = ENV.COPY_PERCENTAGE;

// Polymarket minimum order sizes
const MIN_ORDER_SIZE_USD = 1.0; // Minimum order size in USD for BUY orders
const MIN_ORDER_SIZE_TOKENS = 1.0; // Minimum order size in tokens for SELL/MERGE orders

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

/** CLOB rejects prices outside [0.01, 0.99] — bids at $0.999 crash the executor. */
const CLOB_MIN_PRICE = 0.01;
const CLOB_MAX_PRICE = 0.99;

const clampClobPrice = (price: number): number => {
    if (!Number.isFinite(price)) return CLOB_MIN_PRICE;
    return Math.min(CLOB_MAX_PRICE, Math.max(CLOB_MIN_PRICE, price));
};

type BookLevel = { price: string; size: string };

const resolveTickSize = async (clobClient: ClobClient, tokenID: string): Promise<number> => {
    try {
        const ts = await clobClient.getTickSize(tokenID);
        const n = parseFloat(String(ts));
        if (Number.isFinite(n) && n > 0) return n;
    } catch {
        /* default 1¢ */
    }
    return 0.01;
};

const bestBidAsk = (orderBook: {
    bids?: BookLevel[];
    asks?: BookLevel[];
}): { bestBid: number; bestAsk: number; bidSize: number; askSize: number } => {
    let bestBid = 0;
    let bidSize = 0;
    if (orderBook.bids?.length) {
        const maxBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);
        bestBid = parseFloat(maxBid.price);
        bidSize = parseFloat(maxBid.size);
    }
    let bestAsk = 0;
    let askSize = 0;
    if (orderBook.asks?.length) {
        const minAsk = orderBook.asks.reduce((min, ask) => {
            return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
        }, orderBook.asks[0]);
        bestAsk = parseFloat(minAsk.price);
        askSize = parseFloat(minAsk.size);
    }
    return { bestBid, bestAsk, bidSize, askSize };
};

/** Join the ask side without crossing the bid (post-only safe). */
const makerSellLimit = (bestBid: number, bestAsk: number, tick: number): number => {
    let price = 0;
    if (bestAsk > 0) {
        price = ceilToTick(bestAsk, tick);
        if (bestBid > 0 && price <= bestBid + 1e-12) {
            price = ceilToTick(bestBid + tick, tick);
        }
    } else if (bestBid > 0) {
        price = ceilToTick(bestBid + tick, tick);
    }
    return clampClobPrice(price);
};

export interface PostOrderResult {
    executed: boolean;
    sizeUsd: number;
    paper: boolean;
}

const liveSkip = (): PostOrderResult => ({ executed: false, sizeUsd: 0, paper: false });

const resolveMartingaleLosses = async (
    positions?: Array<{ conditionId?: string; asset?: string; curPrice?: number; size?: number }>
): Promise<number> => {
    if (COPY_STRATEGY_CONFIG.strategy !== CopyStrategy.MARTINGALE) return 0;
    // Paper: rebuild streak from bot_signals + CLOB marks (never live wallet positions)
    if (ENV.PAPER_MODE) {
        return syncPaperMartingaleFromLedger();
    }
    if (positions?.length) {
        syncMartingaleFromPrices(positions, false);
    }
    return getMartingaleConsecutiveLosses(false);
};

const slippageFraction = (): number => {
    const pct = Number(ENV.MAX_SLIPPAGE_PERCENT);
    if (!Number.isFinite(pct) || pct <= 0) return 0.15;
    return pct / 100;
};

const useMakerOrders = (): boolean => ENV.ORDER_EXECUTION === 'maker';

const postOrder = async (
    clobClient: ClobClient | null,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string,
    /** Last agreeing trader's fill — used as the maker BUY limit price */
    slippageRefPrice?: number,
    /** All of our open positions (used to detect opposite-outcome hedge) */
    myPositions?: UserPositionInterface[]
): Promise<PostOrderResult> => {
    const UserActivity = getUserActivityModel(userAddress);
    const refPrice =
        slippageRefPrice !== undefined &&
        Number.isFinite(slippageRefPrice) &&
        slippageRefPrice > 0
            ? Number(slippageRefPrice)
            : Number(trade.price) || 0;

    const positionList = (): Array<{
        asset: string;
        conditionId: string;
        size?: number;
        avgPrice?: number;
        currentValue?: number;
        outcome?: string;
        slug?: string;
        eventSlug?: string;
        sizeUsd?: number;
        tokens?: number;
    }> => {
        if (ENV.PAPER_MODE) {
            return getAllPaperPositions().map((p) => ({
                asset: p.asset,
                conditionId: p.conditionId,
                size: p.tokens,
                avgPrice: p.avgPrice,
                outcome: p.outcome,
                slug: p.slug,
                eventSlug: p.eventSlug,
                sizeUsd: p.sizeUsd,
            }));
        }
        return (myPositions || (my_position ? [my_position] : [])).map((p) => ({
            asset: p.asset,
            conditionId: p.conditionId,
            size: p.size,
            avgPrice: p.avgPrice,
            currentValue: p.currentValue,
            outcome: p.outcome,
            slug: p.slug,
            eventSlug: p.eventSlug,
        }));
    };

    const resolveOppositeHeld = (): {
        avgPrice: number;
        outcome?: string;
        sizeUsd: number;
    } | null => {
        if (ENV.PAPER_MODE) {
            const opp = getOppositePaperPosition(trade.conditionId, trade.asset);
            if (!opp) return null;
            return { avgPrice: opp.avgPrice, outcome: opp.outcome, sizeUsd: opp.sizeUsd };
        }
        const list = myPositions || (my_position ? [my_position] : []);
        const opp = findOppositePosition(list, trade.conditionId, trade.asset);
        if (!opp) return null;
        const sizeUsd =
            (opp.currentValue && opp.currentValue > 0
                ? opp.currentValue
                : (opp.size || 0) * (opp.avgPrice || 0)) || 0;
        return {
            avgPrice: opp.avgPrice,
            outcome: opp.outcome,
            sizeUsd,
        };
    };

    /** Shared BUY skips: max entry, crypto up/down, opposite side, average-down, event family. */
    const evaluateBuyEntryGuards = (
        askPrice: number
    ): { skip: boolean; reason?: string } => {
        const maxEntry = Number(ENV.MAX_ENTRY_PRICE);
        if (
            Number.isFinite(maxEntry) &&
            maxEntry > 0 &&
            Number.isFinite(askPrice) &&
            askPrice > maxEntry + 1e-9
        ) {
            return {
                skip: true,
                reason:
                    `price $${askPrice.toFixed(3)} > MAX_ENTRY_PRICE $${maxEntry.toFixed(2)} ` +
                    `(fees eat remaining edge)`,
            };
        }

        if (
            ENV.SKIP_CRYPTO_UPDOWN &&
            isCryptoUpDownMarket({
                slug: trade.slug,
                eventSlug: trade.eventSlug,
                title: trade.title,
            })
        ) {
            return {
                skip: true,
                reason: 'crypto Up/Down market blocked (SKIP_CRYPTO_UPDOWN)',
            };
        }

        const positions = positionList();
        const oppositeHeld = resolveOppositeHeld();
        if (oppositeHeld) {
            if (ENV.BLOCK_OPPOSITE_SIDE) {
                return {
                    skip: true,
                    reason:
                        `already hold opposite ${oppositeHeld.outcome || 'outcome'} ` +
                        `@$${oppositeHeld.avgPrice.toFixed(3)} — BLOCK_OPPOSITE_SIDE`,
                };
            }
            if (ENV.HEDGE_ARB_ENABLED) {
                const plan = computeHedgeArbPlan(
                    oppositeHeld.avgPrice,
                    askPrice,
                    ENV.HEDGE_ARB_MAX_SUM,
                    ENV.HEDGE_ARB_MAX_LEG
                );
                if (plan.skip || !plan.allowMarket) {
                    return {
                        skip: true,
                        reason: `hedge guard: ${plan.reason}`,
                    };
                }
            }
        }

        if (ENV.BLOCK_AVERAGE_DOWN) {
            const same = findSameAssetPosition(positions, trade.asset);
            const heldAvg = same?.avgPrice || 0;
            if (heldAvg > 0 && isAverageDown(heldAvg, askPrice)) {
                return {
                    skip: true,
                    reason:
                        `average-down blocked (held @$${heldAvg.toFixed(3)}, ask @$${askPrice.toFixed(
                            3
                        )})`,
                };
            }
        }

        if (ENV.BLOCK_EVENT_FAMILY) {
            const family = findEventFamilyPosition(positions, trade);
            if (family) {
                return {
                    skip: true,
                    reason:
                        `event-family blocked — already in ` +
                        `${family.outcome || family.slug || family.eventSlug || 'related market'} ` +
                        `(BLOCK_EVENT_FAMILY)`,
                };
            }
        }

        return { skip: false };
    };

    // Paper / preview mode: log the signal and mark processed — never place orders
    if (ENV.PAPER_MODE) {
        Logger.warning(
            `[PAPER] ENV.PAPER_MODE=true — simulating ${condition.toUpperCase()} (not a live order)`
        );
        const side = condition === 'sell' ? 'SELL' : 'BUY';

        // Never paper-SELL without a prior paper BUY on this asset
        if (side === 'SELL' && !hasOpenPaperPosition(trade.asset)) {
            Logger.warning(
                `[PAPER] Skip SELL — no open position for ` +
                    `${trade.outcome || trade.asset.slice(0, 12)}… ` +
                    `(need a prior entered BUY first)`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 1 });
            return { executed: false, sizeUsd: 0, paper: true };
        }

        if (side === 'BUY') {
            const guard = evaluateBuyEntryGuards(Number(trade.price) || 0);
            if (guard.skip) {
                Logger.warning(`[PAPER] Skip BUY — ${guard.reason}`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 1 });
                return { executed: false, sizeUsd: 0, paper: true };
            }
        }

        // Paper bankroll for sizing — always PAPER_BALANCE_USD (ignore live dust like $0.02)
        const paperBalance =
            Number.isFinite(ENV.PAPER_BALANCE_USD) && ENV.PAPER_BALANCE_USD > 0
                ? ENV.PAPER_BALANCE_USD
                : my_balance > 0
                  ? my_balance
                  : 10000;
        const paperPos = getPaperPosition(trade.asset);
        const martingaleLosses = await resolveMartingaleLosses();
        const orderSize = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            paperBalance,
            paperPos?.sizeUsd || my_position?.currentValue || 0,
            { marketPrice: trade.price, martingaleLosses }
        );

        let sizeUsd = orderSize.finalAmount;
        if (side === 'SELL' && paperPos) {
            // Cap sell to what we actually hold in the paper book
            sizeUsd = Math.min(sizeUsd, paperPos.sizeUsd);
            if (sizeUsd < MIN_ORDER_SIZE_USD) {
                Logger.warning(
                    `[PAPER] Skip SELL — paper position too small ($${paperPos.sizeUsd.toFixed(2)})`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 1 });
                return { executed: false, sizeUsd: 0, paper: true };
            }
        }

        const filled = applyPaperFill(
            side,
            trade.asset,
            trade.conditionId,
            sizeUsd,
            trade.price,
            {
                title: trade.title,
                outcome: trade.outcome,
                slug: trade.slug,
                eventSlug: trade.eventSlug,
            }
        );

        Logger.warning(
            `[PAPER] Would ${condition.toUpperCase()} ` +
                `${trade.outcome || trade.asset.slice(0, 12)}… ` +
                `~$${filled.sizeUsd.toFixed(2)} ` +
                `@ ${trade.price} on ${trade.slug || trade.eventSlug || 'market'} ` +
                `(budget $${paperBalance.toFixed(0)}) ` +
                `(from ${userAddress.slice(0, 6)}…${userAddress.slice(-4)}) — ${orderSize.reasoning}`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 1 });
        return { executed: filled.sizeUsd > 0, sizeUsd: filled.sizeUsd, paper: true };
    }

    // Live mode without a CLOB client must NEVER fall through to paper fills
    if (!clobClient) {
        Logger.error(
            `[LIVE] Skip ${condition.toUpperCase()} — CLOB client not ready ` +
                `(paper mode is OFF). Restart bot or wait for client init.`
        );
        await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: 1 });
        return { executed: false, sizeUsd: 0, paper: false };
    }

    const maker = useMakerOrders();

    // ---------- MERGE ----------
    if (condition === 'merge') {
        Logger.info(`Executing MERGE strategy (${maker ? 'maker' : 'taker'})...`);
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }
        let remaining = my_position.size;
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        if (maker) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            const { bestBid, bestAsk } = bestBidAsk(orderBook);
            const tick = await resolveTickSize(clobClient, trade.asset);
            const sellPrice = makerSellLimit(bestBid, bestAsk, tick);
            if (!(sellPrice > 0)) {
                Logger.warning('No book for maker MERGE — skip');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            const sizeTokens = Math.floor(remaining * 100) / 100;
            Logger.info(
                `📌 Maker MERGE: ${sizeTokens} @ $${sellPrice.toFixed(4)} ` +
                    `(bid $${bestBid.toFixed(4)} / ask $${bestAsk.toFixed(4)})`
            );
            try {
                const resp = await clobClient.createAndPostOrder(
                    {
                        tokenID: my_position.asset,
                        price: sellPrice,
                        size: sizeTokens,
                        side: Side.SELL,
                    },
                    undefined,
                    OrderType.GTC,
                    true
                );
                if (resp.success === true) {
                    const matched = resp.status === 'matched';
                    Logger.orderResult(
                        matched,
                        matched
                            ? `Merged ${sizeTokens} @ $${sellPrice}`
                            : `MERGE resting${resp.orderID ? ` order=${resp.orderID}` : ''}`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return {
                        executed: matched,
                        sizeUsd: matched ? Math.round(sizeTokens * sellPrice * 100) / 100 : 0,
                        paper: false,
                    };
                }
                const errorMessage = extractOrderError(resp);
                Logger.warning(`MERGE maker rejected: ${errorMessage || 'unknown'}`);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    Logger.warning('Top up funds or run `npm run check-allowance` before retrying.');
                }
            } catch (error) {
                Logger.error(
                    `MERGE maker threw: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: RETRY_LIMIT });
            return liveSkip();
        }

        // Taker MERGE — FOK against best bid
        let retry = 0;
        let abortDueToFunds = false;
        let filledUsd = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                Logger.warning('No bids available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);
            const rawBid = parseFloat(maxPriceBid.price);
            const sellPrice = clampClobPrice(rawBid);
            Logger.info(
                `Best bid: ${maxPriceBid.size} @ $${rawBid.toFixed(4)}` +
                    (sellPrice !== rawBid
                        ? ` → clamped $${sellPrice.toFixed(4)} (CLOB 0.01–0.99)`
                        : '')
            );
            const order_arges = {
                side: Side.SELL,
                tokenID: my_position.asset,
                amount:
                    remaining <= parseFloat(maxPriceBid.size)
                        ? remaining
                        : parseFloat(maxPriceBid.size),
                price: sellPrice,
            };
            let resp;
            try {
                resp = await clobClient.createAndPostMarketOrder(
                    order_arges,
                    undefined,
                    OrderType.FOK
                );
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                Logger.error(`MERGE/SELL order threw: ${msg}`);
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, botExcutedTime: RETRY_LIMIT }
                );
                return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
            }
            if (resp.success === true) {
                retry = 0;
                filledUsd += order_arges.amount * order_arges.price;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
        return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
    } else if (condition === 'buy') {
        Logger.info(`Executing BUY strategy (${maker ? 'maker' : 'taker'})...`);
        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;
        const martingaleLosses = await resolveMartingaleLosses(
            myPositions?.length
                ? myPositions
                : my_position
                  ? [my_position]
                  : undefined
        );
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue,
            { marketPrice: trade.price, martingaleLosses }
        );
        Logger.info(`📊 ${orderCalc.reasoning}`);
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        const consensusPrice =
            refPrice > 0 ? refPrice : Number(trade.price) > 0 ? Number(trade.price) : 0;

        let peekAsk = consensusPrice || Number(trade.price) || 0;
        try {
            const book = await clobClient.getOrderBook(trade.asset);
            if (book.asks?.length) {
                const bestAsk = book.asks.reduce((min, ask) => {
                    return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
                }, book.asks[0]);
                peekAsk = parseFloat(bestAsk.price);
            }
        } catch {
            /* use consensus / trade.price */
        }

        const guardPrice = maker ? consensusPrice : peekAsk;
        const entryGuard = evaluateBuyEntryGuards(guardPrice);
        if (entryGuard.skip) {
            Logger.warning(`Skip BUY — ${entryGuard.reason}`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        const oppositeHeld =
            !ENV.BLOCK_OPPOSITE_SIDE && ENV.HEDGE_ARB_ENABLED ? resolveOppositeHeld() : null;
        if (oppositeHeld) {
            const plan = computeHedgeArbPlan(
                oppositeHeld.avgPrice,
                maker ? consensusPrice : peekAsk,
                ENV.HEDGE_ARB_MAX_SUM,
                ENV.HEDGE_ARB_MAX_LEG
            );
            Logger.info(
                `⚖️  Hedge guard vs ${oppositeHeld.outcome || 'other side'} ` +
                    `@$${oppositeHeld.avgPrice.toFixed(3)}: ${plan.reason}`
            );
            if (plan.skip) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            if (!plan.allowMarket) {
                let tick = 0.01;
                try {
                    const ts = await clobClient.getTickSize(trade.asset);
                    const n = parseFloat(String(ts));
                    if (Number.isFinite(n) && n > 0) tick = n;
                } catch {
                    /* default 1¢ */
                }
                const limitPrice = floorToTick(plan.maxLimitPrice, tick);
                if (limitPrice < tick) {
                    Logger.warning(
                        `Hedge limit $${plan.maxLimitPrice.toFixed(4)} below tick $${tick} — skip`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return liveSkip();
                }
                let budgetUsd = orderCalc.finalAmount;
                if (oppositeHeld.sizeUsd > 0) {
                    budgetUsd = Math.min(budgetUsd, oppositeHeld.sizeUsd);
                }
                const sizeTokens = Math.floor((budgetUsd / limitPrice) * 100) / 100;
                if (sizeTokens < MIN_ORDER_SIZE_TOKENS || budgetUsd < MIN_ORDER_SIZE_USD) {
                    Logger.warning(
                        `Hedge limit size too small ($${budgetUsd.toFixed(2)} @ $${limitPrice}) — skip`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return liveSkip();
                }
                Logger.info(
                    `📌 Placing GTC hedge limit: ${sizeTokens} @ $${limitPrice.toFixed(4)} ` +
                        `(held @$${oppositeHeld.avgPrice.toFixed(3)} + limit ≤ $${ENV.HEDGE_ARB_MAX_SUM})`
                );
                try {
                    const resp = await clobClient.createAndPostOrder(
                        {
                            tokenID: trade.asset,
                            price: limitPrice,
                            size: sizeTokens,
                            side: Side.BUY,
                        },
                        undefined,
                        OrderType.GTC,
                        maker
                    );
                    if (resp.success === true) {
                        Logger.success(
                            `Hedge limit resting` +
                                (resp.orderID ? ` order=${resp.orderID}` : '') +
                                (resp.status ? ` status=${resp.status}` : '')
                        );
                        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                        return {
                            executed: resp.status === 'matched',
                            sizeUsd:
                                resp.status === 'matched'
                                    ? Math.round(sizeTokens * limitPrice * 100) / 100
                                    : 0,
                            paper: false,
                        };
                    }
                    Logger.warning(
                        `Hedge limit rejected: ${extractOrderError(resp) || 'unknown'}`
                    );
                } catch (error) {
                    Logger.error(
                        `Hedge limit failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                }
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
        }

        if (maker) {
            if (!(consensusPrice > 0)) {
                Logger.warning('No consensus entry price — skip maker BUY');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            const maxEntry = Number(ENV.MAX_ENTRY_PRICE);
            if (Number.isFinite(maxEntry) && maxEntry > 0 && consensusPrice > maxEntry + 1e-9) {
                Logger.warning(
                    `Skip BUY — consensus $${consensusPrice.toFixed(3)} > MAX_ENTRY_PRICE $${maxEntry.toFixed(2)}`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            const tick = await resolveTickSize(clobClient, trade.asset);
            let buyPrice = floorToTick(consensusPrice, tick);
            if (Number.isFinite(maxEntry) && maxEntry > 0) {
                buyPrice = Math.min(buyPrice, floorToTick(maxEntry, tick));
            }
            buyPrice = clampClobPrice(buyPrice);
            if (!(buyPrice > 0)) {
                Logger.warning(
                    `Invalid maker BUY price from consensus $${consensusPrice.toFixed(4)} — skip`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            let bestAsk = 0;
            let bestBid = 0;
            try {
                const orderBook = await clobClient.getOrderBook(trade.asset);
                ({ bestBid, bestAsk } = bestBidAsk(orderBook));
            } catch {
                /* informational */
            }
            if (bestAsk > 0 && buyPrice >= bestAsk - 1e-12) {
                Logger.info(
                    `Consensus bid $${buyPrice.toFixed(4)} ≥ ask $${bestAsk.toFixed(4)} — ` +
                        `post-only may reject if this crosses; still posting at last-agree price`
                );
            }
            const budgetUsd = orderCalc.finalAmount;
            const sizeTokens = Math.floor((budgetUsd / buyPrice) * 100) / 100;
            const notional = Math.round(sizeTokens * buyPrice * 100) / 100;
            if (sizeTokens < MIN_ORDER_SIZE_TOKENS || notional < MIN_ORDER_SIZE_USD) {
                Logger.warning(
                    `Maker BUY size too small ($${notional.toFixed(2)} / ${sizeTokens} tok @ $${buyPrice}) — skip`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            Logger.info(
                `📌 Maker BUY at consensus: ${sizeTokens} @ $${buyPrice.toFixed(4)} ` +
                    `(last agree $${consensusPrice.toFixed(4)}; ~$${notional.toFixed(2)}; ` +
                    `book ${bestBid.toFixed(4)}/${bestAsk.toFixed(4)}; Balance: $${my_balance.toFixed(2)})`
            );
            try {
                const resp = await clobClient.createAndPostOrder(
                    {
                        tokenID: trade.asset,
                        price: buyPrice,
                        size: sizeTokens,
                        side: Side.BUY,
                    },
                    undefined,
                    OrderType.GTC,
                    true
                );
                if (resp.success === true) {
                    const matched = resp.status === 'matched';
                    const filledUsd = matched ? notional : 0;
                    Logger.orderResult(
                        matched,
                        matched
                            ? `Bought ${sizeTokens} @ $${buyPrice} ($${notional.toFixed(2)})`
                            : `BUY resting${resp.orderID ? ` order=${resp.orderID}` : ''} @ $${buyPrice}`
                    );
                    await UserActivity.updateOne(
                        { _id: trade._id },
                        { bot: true, myBoughtSize: matched ? sizeTokens : 0 }
                    );
                    if (matched) {
                        Logger.info(
                            `📝 Tracked purchase: ${sizeTokens.toFixed(2)} tokens for future sell calculations`
                        );
                    }
                    return { executed: matched, sizeUsd: filledUsd, paper: false };
                }
                const errorMessage = extractOrderError(resp);
                Logger.warning(`BUY maker rejected: ${errorMessage || 'unknown'}`);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    Logger.warning('Top up funds or run `npm run check-allowance` before retrying.');
                }
            } catch (error) {
                Logger.error(
                    `BUY maker threw: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: RETRY_LIMIT });
            return liveSkip();
        }

        // Taker BUY — FOK against best ask with slippage band
        let remaining = orderCalc.finalAmount;
        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0;
        let filledUsd = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.asks || orderBook.asks.length === 0) {
                Logger.warning('No asks available in order book');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            const minPriceAsk = orderBook.asks.reduce((min, ask) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);
            const askPrice = parseFloat(minPriceAsk.price);

            const maxEntry = Number(ENV.MAX_ENTRY_PRICE);
            if (Number.isFinite(maxEntry) && maxEntry > 0 && askPrice > maxEntry + 1e-9) {
                Logger.warning(
                    `Skip BUY — ask $${askPrice.toFixed(3)} > MAX_ENTRY_PRICE $${maxEntry.toFixed(2)}`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            if (ENV.SKIP_PRICE_SLIPPAGE) {
                Logger.info(
                    `Best ask: ${minPriceAsk.size} @ $${askPrice.toFixed(4)} | ` +
                        `ref buy $${refPrice.toFixed(4)} | slippage check skipped`
                );
            } else {
                const slip = slippageFraction();
                const minAsk = refPrice * (1 - slip);
                const maxAsk = refPrice * (1 + slip);
                Logger.info(
                    `Best ask: ${minPriceAsk.size} @ $${askPrice.toFixed(4)} | ` +
                        `ref buy $${refPrice.toFixed(4)} | ` +
                        `allowed ±${(slip * 100).toFixed(0)}% [$${minAsk.toFixed(4)} … $${maxAsk.toFixed(4)}]`
                );
                if (!(askPrice >= minAsk && askPrice <= maxAsk)) {
                    Logger.warning(
                        `Price slippage too high - skipping trade ` +
                            `(ask $${askPrice.toFixed(4)} outside ±${(slip * 100).toFixed(0)}% of ` +
                            `ref buy $${refPrice.toFixed(4)})`
                    );
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    break;
                }
            }

            if (remaining < MIN_ORDER_SIZE_USD) {
                Logger.info(
                    `Remaining amount ($${remaining.toFixed(2)}) below minimum - completing trade`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, myBoughtSize: totalBoughtTokens }
                );
                break;
            }
            const maxOrderSize = parseFloat(minPriceAsk.size) * askPrice;
            const orderSize = Math.floor(Math.min(remaining, maxOrderSize) * 100) / 100;
            if (orderSize < MIN_ORDER_SIZE_USD) {
                Logger.info(
                    `Rounded order size ($${orderSize.toFixed(2)}) below minimum — completing trade`
                );
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, myBoughtSize: totalBoughtTokens }
                );
                break;
            }
            const buyPrice = clampClobPrice(askPrice);
            if (buyPrice !== askPrice) {
                Logger.info(
                    `Clamped ask $${askPrice.toFixed(4)} → $${buyPrice.toFixed(4)} (CLOB 0.01–0.99)`
                );
            }
            const order_arges = {
                side: Side.BUY,
                tokenID: trade.asset,
                amount: orderSize,
                price: buyPrice,
            };
            Logger.info(
                `Creating order: $${orderSize.toFixed(2)} @ $${buyPrice} (Balance: $${my_balance.toFixed(2)})`
            );
            let resp;
            try {
                resp = await clobClient.createAndPostMarketOrder(
                    order_arges,
                    undefined,
                    OrderType.FOK
                );
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                Logger.error(`BUY order threw: ${msg}`);
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
                );
                return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
            }
            if (resp.success === true) {
                retry = 0;
                const tokensBought = order_arges.amount / order_arges.price;
                totalBoughtTokens += tokensBought;
                filledUsd += order_arges.amount;
                Logger.orderResult(
                    true,
                    `Bought $${order_arges.amount.toFixed(2)} at $${order_arges.price} (${tokensBought.toFixed(2)} tokens)`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT, myBoughtSize: totalBoughtTokens }
            );
            return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: retry, myBoughtSize: totalBoughtTokens }
            );
        } else {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, myBoughtSize: totalBoughtTokens }
            );
        }
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
            );
        }
        return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
    } else if (condition === 'sell') {
        Logger.info(`Executing SELL strategy (${maker ? 'maker' : 'taker'})...`);
        let remaining = 0;
        if (!my_position) {
            Logger.warning('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }
        const previousBuys = await UserActivity.find({
            asset: trade.asset,
            conditionId: trade.conditionId,
            side: 'BUY',
            bot: true,
            myBoughtSize: { $exists: true, $gt: 0 },
        }).exec();
        const totalBoughtTokens = previousBuys.reduce(
            (sum, buy) => sum + (buy.myBoughtSize || 0),
            0
        );
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📊 Found ${previousBuys.length} previous purchases: ${totalBoughtTokens.toFixed(2)} tokens bought`
            );
        }
        if (!user_position) {
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;
            Logger.info(
                `Position comparison: Trader has ${trader_position_before.toFixed(2)} tokens, You have ${my_position.size.toFixed(2)} tokens`
            );
            Logger.info(
                `Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
            );
            let baseSellSize;
            if (totalBoughtTokens > 0) {
                baseSellSize = totalBoughtTokens * trader_sell_percent;
                Logger.info(
                    `Calculating from tracked purchases: ${totalBoughtTokens.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            } else {
                baseSellSize = my_position.size * trader_sell_percent;
                Logger.warning(
                    `No tracked purchases found, using current position: ${my_position.size.toFixed(2)} × ${(trader_sell_percent * 100).toFixed(2)}% = ${baseSellSize.toFixed(2)} tokens`
                );
            }
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;
            if (multiplier !== 1.0) {
                Logger.info(
                    `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} tokens`
                );
            }
        }
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
            );
            Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            remaining = my_position.size;
        }

        if (maker) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            const { bestBid, bestAsk } = bestBidAsk(orderBook);
            const tick = await resolveTickSize(clobClient, trade.asset);
            const sellPrice = makerSellLimit(bestBid, bestAsk, tick);
            if (!(sellPrice > 0)) {
                Logger.warning('No book for maker SELL — skip');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            const sizeTokens = Math.floor(remaining * 100) / 100;
            if (sizeTokens < MIN_ORDER_SIZE_TOKENS) {
                Logger.warning(`Maker SELL size too small (${sizeTokens} tokens) — skip`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return liveSkip();
            }
            Logger.info(
                `📌 Maker SELL: ${sizeTokens} @ $${sellPrice.toFixed(4)} ` +
                    `(bid $${bestBid.toFixed(4)} / ask $${bestAsk.toFixed(4)})`
            );
            try {
                const resp = await clobClient.createAndPostOrder(
                    {
                        tokenID: trade.asset,
                        price: sellPrice,
                        size: sizeTokens,
                        side: Side.SELL,
                    },
                    undefined,
                    OrderType.GTC,
                    true
                );
                if (resp.success === true) {
                    const matched = resp.status === 'matched';
                    const totalSoldTokens = matched ? sizeTokens : 0;
                    const filledUsd = matched
                        ? Math.round(sizeTokens * sellPrice * 100) / 100
                        : 0;
                    Logger.orderResult(
                        matched,
                        matched
                            ? `Sold ${sizeTokens} @ $${sellPrice}`
                            : `SELL resting${resp.orderID ? ` order=${resp.orderID}` : ''} @ $${sellPrice}`
                    );
                    if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
                        const sellPercentage = totalSoldTokens / totalBoughtTokens;
                        if (sellPercentage >= 0.99) {
                            await UserActivity.updateMany(
                                {
                                    asset: trade.asset,
                                    conditionId: trade.conditionId,
                                    side: 'BUY',
                                    bot: true,
                                    myBoughtSize: { $exists: true, $gt: 0 },
                                },
                                { $set: { myBoughtSize: 0 } }
                            );
                            Logger.info(
                                `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
                            );
                        } else {
                            for (const buy of previousBuys) {
                                const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                                await UserActivity.updateOne(
                                    { _id: buy._id },
                                    { $set: { myBoughtSize: newSize } }
                                );
                            }
                            Logger.info(
                                `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
                            );
                        }
                    }
                    await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                    return { executed: matched, sizeUsd: filledUsd, paper: false };
                }
                const errorMessage = extractOrderError(resp);
                Logger.warning(`SELL maker rejected: ${errorMessage || 'unknown'}`);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    Logger.warning('Top up funds or run `npm run check-allowance` before retrying.');
                }
            } catch (error) {
                Logger.error(
                    `SELL maker threw: ${error instanceof Error ? error.message : String(error)}`
                );
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: RETRY_LIMIT });
            return liveSkip();
        }

        // Taker SELL — FOK against best bid
        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0;
        let filledUsd = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            const orderBook = await clobClient.getOrderBook(trade.asset);
            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                Logger.warning('No bids available in order book');
                break;
            }
            const maxPriceBid = orderBook.bids.reduce((max, bid) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);
            const rawBid = parseFloat(maxPriceBid.price);
            const sellPrice = clampClobPrice(rawBid);
            Logger.info(
                `Best bid: ${maxPriceBid.size} @ $${rawBid.toFixed(4)}` +
                    (sellPrice !== rawBid
                        ? ` → clamped $${sellPrice.toFixed(4)} (CLOB 0.01–0.99)`
                        : '')
            );
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));
            if (sellAmount < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Order amount (${sellAmount.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            const order_arges = {
                side: Side.SELL,
                tokenID: trade.asset,
                amount: sellAmount,
                price: sellPrice,
            };
            let resp;
            try {
                resp = await clobClient.createAndPostMarketOrder(
                    order_arges,
                    undefined,
                    OrderType.FOK
                );
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                Logger.error(`SELL order threw: ${msg}`);
                await UserActivity.updateOne(
                    { _id: trade._id },
                    { bot: true, botExcutedTime: RETRY_LIMIT }
                );
                return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
            }
            if (resp.success === true) {
                retry = 0;
                totalSoldTokens += order_arges.amount;
                filledUsd += order_arges.amount * order_arges.price;
                Logger.orderResult(
                    true,
                    `Sold ${order_arges.amount} tokens at $${order_arges.price}`
                );
                remaining -= order_arges.amount;
            } else {
                const errorMessage = extractOrderError(resp);
                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    abortDueToFunds = true;
                    Logger.warning(
                        `Order rejected: ${errorMessage || 'Insufficient balance or allowance'}`
                    );
                    Logger.warning(
                        'Skipping remaining attempts. Top up funds or run `npm run check-allowance` before retrying.'
                    );
                    break;
                }
                retry += 1;
                Logger.warning(
                    `Order failed (attempt ${retry}/${RETRY_LIMIT})${errorMessage ? ` - ${errorMessage}` : ''}`
                );
            }
        }
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;
            if (sellPercentage >= 0.99) {
                await UserActivity.updateMany(
                    {
                        asset: trade.asset,
                        conditionId: trade.conditionId,
                        side: 'BUY',
                        bot: true,
                        myBoughtSize: { $exists: true, $gt: 0 },
                    },
                    { $set: { myBoughtSize: 0 } }
                );
                Logger.info(
                    `🧹 Cleared purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of position)`
                );
            } else {
                for (const buy of previousBuys) {
                    const newSize = (buy.myBoughtSize || 0) * (1 - sellPercentage);
                    await UserActivity.updateOne(
                        { _id: buy._id },
                        { $set: { myBoughtSize: newSize } }
                    );
                }
                Logger.info(
                    `📝 Updated purchase tracking (sold ${(sellPercentage * 100).toFixed(1)}% of tracked position)`
                );
            }
        }
        if (abortDueToFunds) {
            await UserActivity.updateOne(
                { _id: trade._id },
                { bot: true, botExcutedTime: RETRY_LIMIT }
            );
            return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
        return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
    } else {
        Logger.error(`Unknown condition: ${condition}`);
        return liveSkip();
    }
};


export default postOrder;
