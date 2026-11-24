import type { UserActivity } from './graviaClient';

export const CRYPTO_5M_SLUG_RE = /updown-5m/i;

export type ActivityCadence = {
    tradeCount: number;
    activeDays: number;
    tradesPerDay: number;
    lookbackDays: number;
};

export type BothSidesResult = {
    betsBothSides: boolean;
    dualSidedMarkets: number;
    sampleConditionIds: string[];
};

/** True when the activity is a crypto up/down 5m market trade. */
export function isCrypto5mTrade(activity: UserActivity): boolean {
    const type = (activity.type || 'trade').toLowerCase();
    if (type && type !== 'trade') return false;
    const slug = activity.slug || activity.market?.slug || '';
    return CRYPTO_5M_SLUG_RE.test(slug);
}

export function activityUtcDay(isoOrMs: string | number | undefined): string | null {
    if (isoOrMs === undefined || isoOrMs === null) return null;
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

/**
 * Count crypto-5m trades and distinct UTC days in the lookback window.
 */
export function measureActivityCadence(
    activities: UserActivity[],
    lookbackDays: number,
    now = new Date()
): ActivityCadence {
    const cutoff = now.getTime() - lookbackDays * 86_400_000;
    const days = new Set<string>();
    let tradeCount = 0;

    for (const a of activities) {
        if (!isCrypto5mTrade(a)) continue;
        const ts = a.timestamp ? Date.parse(a.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        tradeCount += 1;
        const day = activityUtcDay(a.timestamp);
        if (day) days.add(day);
    }

    return {
        tradeCount,
        activeDays: days.size,
        tradesPerDay: tradeCount / Math.max(lookbackDays, 1),
        lookbackDays,
    };
}

/**
 * Detect traders who bought more than one distinct outcome in the same market.
 * Uses condition_id + outcome (or token_id as fallback).
 */
export function detectBothSidesBetting(activities: UserActivity[]): BothSidesResult {
    const byMarket = new Map<string, Set<string>>();

    for (const a of activities) {
        if (!isCrypto5mTrade(a)) continue;
        const side = (a.side || 'BUY').toUpperCase();
        // Selling one side is fine; buying both outcomes is the hedge/spam pattern we reject.
        if (side === 'SELL') continue;

        const conditionId = (
            a.condition_id ||
            a.market?.condition_id ||
            ''
        ).toLowerCase();
        if (!conditionId) continue;

        const outcomeKey = (a.outcome || a.token_id || '').toString().toLowerCase();
        if (!outcomeKey) continue;

        let set = byMarket.get(conditionId);
        if (!set) {
            set = new Set();
            byMarket.set(conditionId, set);
        }
        set.add(outcomeKey);
    }

    const dual: string[] = [];
    for (const [cid, outcomes] of byMarket) {
        if (outcomes.size >= 2) dual.push(cid);
    }

    return {
        betsBothSides: dual.length > 0,
        dualSidedMarkets: dual.length,
        sampleConditionIds: dual.slice(0, 5),
    };
}

export function computeRoi(pnlTotal: number, volumeBuy: number, volumeTotal: number): number {
    const denom = volumeBuy > 0 ? volumeBuy : volumeTotal;
    if (!(denom > 0)) return 0;
    return pnlTotal / denom;
}

export type GateInput = {
    pnlTotal: number;
    roi: number;
    winRate: number | null;
    volumeTotal: number;
    cadence: ActivityCadence;
    betsBothSides: boolean;
    minRoi: number;
    minWinRate: number;
    minVolumeUsd: number;
    minTradesPerDay: number;
    minActiveDaysPerWeek: number;
};

export type GateResult = {
    pass: boolean;
    reasons: string[];
};

export function evaluateGates(input: GateInput): GateResult {
    const reasons: string[] = [];

    if (!(input.pnlTotal > 0)) reasons.push('non_positive_30d_pnl');
    if (!(input.roi >= input.minRoi)) reasons.push(`roi_below_${input.minRoi}`);
    if (input.winRate === null || !(input.winRate >= input.minWinRate)) {
        reasons.push(`win_rate_below_${input.minWinRate}`);
    }
    if (!(input.volumeTotal >= input.minVolumeUsd)) reasons.push('volume_too_low');
    if (!(input.cadence.tradesPerDay >= input.minTradesPerDay)) {
        reasons.push('trades_per_day_too_low');
    }
    if (!(input.cadence.activeDays >= input.minActiveDaysPerWeek)) {
        reasons.push('active_days_too_low');
    }
    if (input.betsBothSides) reasons.push('bets_both_sides');

    return { pass: reasons.length === 0, reasons };
}
