/**
 * Safety guard when we already hold one outcome of a binary market and
 * consensus wants the other side: only enter if both legs stay cheap enough
 * for an arbitrage-style hedge (default: each < $0.90 and sum ≤ $0.90).
 */

export const DEFAULT_HEDGE_ARB_MAX_SUM = 0.9;
export const DEFAULT_HEDGE_ARB_MAX_LEG = 0.9;

export interface OppositeHeld {
    asset: string;
    conditionId: string;
    avgPrice: number;
    size: number;
    sizeUsd: number;
    outcome?: string;
}

export interface HedgeArbPlan {
    /** True when we already hold the other outcome of this market. */
    isHedge: boolean;
    /** Allow an immediate marketable buy at `marketPrice`. */
    allowMarket: boolean;
    /** Max limit price for a GTC buy that keeps the pair under the arb sum. */
    maxLimitPrice: number;
    /** Skip entirely (held leg already too expensive / no room). */
    skip: boolean;
    reason: string;
    heldAvgPrice: number;
}

export const computeHedgeArbPlan = (
    heldAvgPrice: number,
    marketPrice: number,
    maxSum: number = DEFAULT_HEDGE_ARB_MAX_SUM,
    maxLeg: number = DEFAULT_HEDGE_ARB_MAX_LEG
): HedgeArbPlan => {
    const held = Number(heldAvgPrice);
    const mkt = Number(marketPrice);

    if (!Number.isFinite(held) || held <= 0) {
        return {
            isHedge: false,
            allowMarket: true,
            maxLimitPrice: maxLeg,
            skip: false,
            reason: 'no opposite position',
            heldAvgPrice: 0,
        };
    }

    if (held >= maxLeg) {
        return {
            isHedge: true,
            allowMarket: false,
            maxLimitPrice: 0,
            skip: true,
            reason: `held leg @$${held.toFixed(3)} ≥ max leg $${maxLeg.toFixed(2)} — skip opposite`,
            heldAvgPrice: held,
        };
    }

    // Room left so held + new ≤ maxSum, and new itself < maxLeg
    const room = maxSum - held;
    const maxLimitPrice = Math.min(maxLeg - 1e-9, room);
    if (!(maxLimitPrice > 0.01)) {
        return {
            isHedge: true,
            allowMarket: false,
            maxLimitPrice: 0,
            skip: true,
            reason: `no arb room (held @$${held.toFixed(3)}, max sum $${maxSum.toFixed(2)})`,
            heldAvgPrice: held,
        };
    }

    const bothUnderLeg =
        held < maxLeg && Number.isFinite(mkt) && mkt > 0 && mkt < maxLeg;
    const sumOk = Number.isFinite(mkt) && mkt > 0 && held + mkt <= maxSum + 1e-9;

    if (bothUnderLeg && sumOk && mkt <= maxLimitPrice + 1e-9) {
        return {
            isHedge: true,
            allowMarket: true,
            maxLimitPrice,
            skip: false,
            reason:
                `hedge arb OK: held @$${held.toFixed(3)} + ask @$${mkt.toFixed(3)} ` +
                `= $${(held + mkt).toFixed(3)} ≤ $${maxSum.toFixed(2)}`,
            heldAvgPrice: held,
        };
    }

    return {
        isHedge: true,
        allowMarket: false,
        maxLimitPrice,
        skip: false,
        reason:
            `hedge: held @$${held.toFixed(3)} — place limit ≤ $${maxLimitPrice.toFixed(3)} ` +
            `(ask $${Number.isFinite(mkt) ? mkt.toFixed(3) : '?'}; need both legs < $${maxLeg.toFixed(
                2
            )} and sum ≤ $${maxSum.toFixed(2)})`,
        heldAvgPrice: held,
    };
};

/** Round price down to tick (default 1¢). */
export const floorToTick = (price: number, tick = 0.01): number => {
    if (!(price > 0) || !(tick > 0)) return 0;
    const decimals = Math.max(0, Math.round(-Math.log10(tick)));
    const scaled = Math.floor(price / tick + 1e-9);
    return Number((scaled * tick).toFixed(decimals));
};

export const findOppositePosition = <
    T extends { asset: string; conditionId: string; size?: number; avgPrice?: number },
>(
    positions: T[],
    conditionId: string,
    asset: string
): T | undefined => {
    if (!conditionId || !asset) return undefined;
    return positions.find(
        (p) =>
            p.conditionId === conditionId &&
            p.asset !== asset &&
            (p.size || 0) > 1e-8 &&
            (p.avgPrice || 0) > 0
    );
};
