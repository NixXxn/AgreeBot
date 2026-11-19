import { ClobClient, OrderType, Side } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import Logger from './logger';
import { calculateOrderSize, getTradeMultiplier } from '../config/copyStrategy';
import {
    applyPaperFill,
    getAllPaperPositions,
    getOppositePaperPosition,
    getPaperPosition,
    hasOpenPaperPosition,
} from '../services/paperPositions';
import {
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

export interface PostOrderResult {
    executed: boolean;
    sizeUsd: number;
    paper: boolean;
}

const liveSkip = (): PostOrderResult => ({ executed: false, sizeUsd: 0, paper: false });

/** Max ± fraction from reference price (default 15%). */
const slippageFraction = (): number => {
    const pct = Number(ENV.MAX_SLIPPAGE_PERCENT);
    if (!Number.isFinite(pct) || pct <= 0) return 0.15;
    return pct / 100;
};

const postOrder = async (
    clobClient: ClobClient | null,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number,
    userAddress: string,
    /** Price for slippage band — last agreeing trader's fill for consensus */
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

    /** Shared BUY skips: crypto up/down, opposite side, average-down, event family. */
    const evaluateBuyEntryGuards = (
        askPrice: number
    ): { skip: boolean; reason?: string } => {
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
        const orderSize = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            paperBalance,
            paperPos?.sizeUsd || my_position?.currentValue || 0,
            { marketPrice: trade.price }
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

    //Merge strategy
    if (condition === 'merge') {
        Logger.info('Executing MERGE strategy...');
        if (!my_position) {
            Logger.warning('No position to merge');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }
        let remaining = my_position.size;

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `Position size (${remaining.toFixed(2)} tokens) too small to merge - skipping`
            );
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

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
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: sellPrice,
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: sellPrice,
                };
            }
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
        //Buy strategy
        Logger.info('Executing BUY strategy...');

        Logger.info(`Your balance: $${my_balance.toFixed(2)}`);
        Logger.info(`Trader bought: $${trade.usdcSize.toFixed(2)}`);

        // Get current position size for position limit checks
        const currentPositionValue = my_position ? my_position.size * my_position.avgPrice : 0;

        // Use new copy strategy system (KELLY uses your bankroll + market price, not trader size)
        const orderCalc = calculateOrderSize(
            COPY_STRATEGY_CONFIG,
            trade.usdcSize,
            my_balance,
            currentPositionValue,
            { marketPrice: trade.price }
        );

        // Log the calculation reasoning
        Logger.info(`📊 ${orderCalc.reasoning}`);

        // Check if order should be executed
        if (orderCalc.finalAmount === 0) {
            Logger.warning(`❌ Cannot execute: ${orderCalc.reasoning}`);
            if (orderCalc.belowMinimum) {
                Logger.warning(`💡 Increase COPY_SIZE or wait for larger trades`);
            }
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        // Peek ask for entry guards (opposite / avg-down / event family / crypto)
        let peekAsk = Number(trade.price) || 0;
        try {
            const book = await clobClient.getOrderBook(trade.asset);
            if (book.asks?.length) {
                const bestAsk = book.asks.reduce((min, ask) => {
                    return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
                }, book.asks[0]);
                peekAsk = parseFloat(bestAsk.price);
            }
        } catch {
            /* use trade.price */
        }

        const entryGuard = evaluateBuyEntryGuards(peekAsk);
        if (entryGuard.skip) {
            Logger.warning(`Skip BUY — ${entryGuard.reason}`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        // Legacy hedge GTC path only when opposite is allowed and arb mode is on
        const oppositeHeld =
            !ENV.BLOCK_OPPOSITE_SIDE && ENV.HEDGE_ARB_ENABLED ? resolveOppositeHeld() : null;
        if (oppositeHeld) {
            const plan = computeHedgeArbPlan(
                oppositeHeld.avgPrice,
                peekAsk,
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

                // Size in shares; cap notional near opposite position when known
                let budgetUsd = orderCalc.finalAmount;
                if (oppositeHeld.sizeUsd > 0) {
                    budgetUsd = Math.min(budgetUsd, oppositeHeld.sizeUsd);
                }
                const sizeTokens =
                    Math.floor((budgetUsd / limitPrice) * 100) / 100;
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
                        false
                    );
                    if (resp.success === true) {
                        Logger.success(
                            `Hedge limit resting` +
                                (resp.orderID ? ` order=${resp.orderID}` : '') +
                                (resp.status ? ` status=${resp.status}` : '')
                        );
                        // Not filled yet — count as not entered for ledger; order is live on book
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

        let remaining = orderCalc.finalAmount;

        let retry = 0;
        let abortDueToFunds = false;
        let totalBoughtTokens = 0; // Track total tokens bought for this trade
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

            // Check if remaining amount is below minimum before creating order
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
            // CLOB v2 market buys: max 2 decimal places on USDC amount
            const orderSize =
                Math.floor(Math.min(remaining, maxOrderSize) * 100) / 100;
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

        // Log the tracked purchase for later sell reference
        if (totalBoughtTokens > 0) {
            Logger.info(
                `📝 Tracked purchase: ${totalBoughtTokens.toFixed(2)} tokens for future sell calculations`
            );
        }
        return { executed: filledUsd > 0, sizeUsd: filledUsd, paper: false };
    } else if (condition === 'sell') {
        //Sell strategy
        Logger.info('Executing SELL strategy...');
        let remaining = 0;
        if (!my_position) {
            Logger.warning('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        // Get all previous BUY trades for this asset to calculate total bought
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
            // Trader sold entire position - we sell entire position too
            remaining = my_position.size;
            Logger.info(
                `Trader closed entire position → Selling all your ${remaining.toFixed(2)} tokens`
            );
        } else {
            // Calculate the % of position the trader is selling
            const trader_sell_percent = trade.size / (user_position.size + trade.size);
            const trader_position_before = user_position.size + trade.size;

            Logger.info(
                `Position comparison: Trader has ${trader_position_before.toFixed(2)} tokens, You have ${my_position.size.toFixed(2)} tokens`
            );
            Logger.info(
                `Trader selling: ${trade.size.toFixed(2)} tokens (${(trader_sell_percent * 100).toFixed(2)}% of their position)`
            );

            // Use tracked bought tokens if available, otherwise fallback to current position
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

            // Apply tiered or single multiplier based on trader's order size (symmetrical with BUY logic)
            const multiplier = getTradeMultiplier(COPY_STRATEGY_CONFIG, trade.usdcSize);
            remaining = baseSellSize * multiplier;

            if (multiplier !== 1.0) {
                Logger.info(
                    `Applying ${multiplier}x multiplier (based on trader's $${trade.usdcSize.toFixed(2)} order): ${baseSellSize.toFixed(2)} → ${remaining.toFixed(2)} tokens`
                );
            }
        }

        // Check minimum order size
        if (remaining < MIN_ORDER_SIZE_TOKENS) {
            Logger.warning(
                `❌ Cannot execute: Sell amount ${remaining.toFixed(2)} tokens below minimum (${MIN_ORDER_SIZE_TOKENS} token)`
            );
            Logger.warning(`💡 This happens when position sizes are too small or mismatched`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return liveSkip();
        }

        // Cap sell amount to available position size
        if (remaining > my_position.size) {
            Logger.warning(
                `⚠️  Calculated sell ${remaining.toFixed(2)} tokens > Your position ${my_position.size.toFixed(2)} tokens`
            );
            Logger.warning(`Capping to maximum available: ${my_position.size.toFixed(2)} tokens`);
            remaining = my_position.size;
        }

        let retry = 0;
        let abortDueToFunds = false;
        let totalSoldTokens = 0; // Track total tokens sold
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

            // Check if remaining amount is below minimum before creating order
            if (remaining < MIN_ORDER_SIZE_TOKENS) {
                Logger.info(
                    `Remaining amount (${remaining.toFixed(2)} tokens) below minimum - completing trade`
                );
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const sellAmount = Math.min(remaining, parseFloat(maxPriceBid.size));

            // Final check: don't create orders below minimum
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

        // Update tracked purchases after successful sell
        if (totalSoldTokens > 0 && totalBoughtTokens > 0) {
            const sellPercentage = totalSoldTokens / totalBoughtTokens;

            if (sellPercentage >= 0.99) {
                // Sold essentially all tracked tokens - clear tracking
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
                // Partial sell - reduce tracked purchases proportionally
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
