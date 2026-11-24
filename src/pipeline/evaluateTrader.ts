import { PIPELINE } from './config';
import {
    collectUserActivities,
    getUserCategoryMetrics,
    pickCryptoCategory,
} from './graviaClient';
import {
    detectBothSidesBetting,
    evaluateGates,
    computeRoi,
    measureActivityCadence,
} from './filters';
import type { EvaluationSnapshot } from './models';

export async function evaluateTrader(address: string): Promise<EvaluationSnapshot> {
    const wallet = address.toLowerCase();
    const metrics = await getUserCategoryMetrics(wallet, '30d');
    const category = pickCryptoCategory(metrics.categories || []);

    const pnl30d = category?.pnl.total ?? 0;
    const volumeBuy = category?.volume.buy ?? 0;
    const volume30d = category?.volume.total ?? 0;
    const winRate = category?.win_rate ?? null;
    const roi = computeRoi(pnl30d, volumeBuy, volume30d);

    // Cheap reject before spending activity pages
    const earlyFail =
        !(pnl30d > 0) ||
        !(roi >= PIPELINE.MIN_ROI) ||
        winRate === null ||
        !(winRate >= PIPELINE.MIN_WIN_RATE) ||
        !(volume30d >= PIPELINE.MIN_VOLUME_USD);

    if (earlyFail) {
        const gate = evaluateGates({
            pnlTotal: pnl30d,
            roi,
            winRate,
            volumeTotal: volume30d,
            cadence: {
                tradeCount: 0,
                activeDays: 0,
                tradesPerDay: 0,
                lookbackDays: PIPELINE.ACTIVITY_LOOKBACK_DAYS,
            },
            betsBothSides: false,
            minRoi: PIPELINE.MIN_ROI,
            minWinRate: PIPELINE.MIN_WIN_RATE,
            minVolumeUsd: PIPELINE.MIN_VOLUME_USD,
            minTradesPerDay: PIPELINE.MIN_TRADES_PER_DAY,
            minActiveDaysPerWeek: PIPELINE.MIN_ACTIVE_DAYS_PER_WEEK,
        });
        return {
            evaluatedAt: new Date(),
            pass: false,
            reasons: gate.reasons.length ? gate.reasons : ['early_reject'],
            pnl30d,
            roi,
            winRate,
            volume30d,
            tradesPerDay: 0,
            activeDays: 0,
            tradeCount7d: 0,
            betsBothSides: false,
            dualSidedMarkets: 0,
            categorySlug: category?.slug,
            score: scoreTrader({ pass: false, roi, pnl30d, winRate, volume30d }),
        };
    }

    const from = new Date(
        Date.now() - PIPELINE.ACTIVITY_LOOKBACK_DAYS * 86_400_000
    ).toISOString();
    const activities = await collectUserActivities(wallet, {
        from,
        types: 'trade',
        maxPages: 8,
    });

    const cadence = measureActivityCadence(activities, PIPELINE.ACTIVITY_LOOKBACK_DAYS);
    const both = detectBothSidesBetting(activities);
    const gate = evaluateGates({
        pnlTotal: pnl30d,
        roi,
        winRate,
        volumeTotal: volume30d,
        cadence,
        betsBothSides: both.betsBothSides,
        minRoi: PIPELINE.MIN_ROI,
        minWinRate: PIPELINE.MIN_WIN_RATE,
        minVolumeUsd: PIPELINE.MIN_VOLUME_USD,
        minTradesPerDay: PIPELINE.MIN_TRADES_PER_DAY,
        minActiveDaysPerWeek: PIPELINE.MIN_ACTIVE_DAYS_PER_WEEK,
    });

    return {
        evaluatedAt: new Date(),
        pass: gate.pass,
        reasons: gate.reasons,
        pnl30d,
        roi,
        winRate,
        volume30d,
        tradesPerDay: cadence.tradesPerDay,
        activeDays: cadence.activeDays,
        tradeCount7d: cadence.tradeCount,
        betsBothSides: both.betsBothSides,
        dualSidedMarkets: both.dualSidedMarkets,
        categorySlug: category?.slug,
        score: scoreTrader({
            pass: gate.pass,
            roi,
            pnl30d,
            winRate,
            volume30d,
        }),
    };
}

export function scoreTrader(input: {
    pass: boolean;
    roi: number;
    pnl30d: number;
    winRate: number | null;
    volume30d: number;
}): number {
    if (!input.pass) return -1;
    const wr = input.winRate ?? 0;
    const volBoost = Math.log10(Math.max(input.volume30d, 10));
    return input.roi * 100 + Math.max(input.pnl30d, 0) * 0.01 + wr * 10 + volBoost;
}
