import {
    computeRoi,
    detectBothSidesBetting,
    evaluateGates,
    isCrypto5mTrade,
    measureActivityCadence,
} from '../filters';
import type { UserActivity } from '../graviaClient';

describe('pipeline filters', () => {
    it('detects crypto 5m slugs', () => {
        expect(
            isCrypto5mTrade({
                type: 'trade',
                slug: 'btc-updown-5m-1783674600',
            })
        ).toBe(true);
        expect(
            isCrypto5mTrade({
                type: 'trade',
                slug: 'will-bitcoin-hit-100k',
            })
        ).toBe(false);
    });

    it('flags both-sides betting on one condition', () => {
        const activities: UserActivity[] = [
            {
                type: 'trade',
                side: 'BUY',
                outcome: 'Up',
                condition_id: '0xabc',
                slug: 'btc-updown-5m-1',
            },
            {
                type: 'trade',
                side: 'BUY',
                outcome: 'Down',
                condition_id: '0xabc',
                slug: 'btc-updown-5m-1',
            },
        ];
        const result = detectBothSidesBetting(activities);
        expect(result.betsBothSides).toBe(true);
        expect(result.dualSidedMarkets).toBe(1);
    });

    it('allows one-sided markets', () => {
        const activities: UserActivity[] = [
            {
                type: 'trade',
                side: 'BUY',
                outcome: 'Up',
                condition_id: '0xabc',
                slug: 'eth-updown-5m-1',
            },
            {
                type: 'trade',
                side: 'BUY',
                outcome: 'Up',
                condition_id: '0xdef',
                slug: 'eth-updown-5m-2',
            },
        ];
        expect(detectBothSidesBetting(activities).betsBothSides).toBe(false);
    });

    it('measures cadence over lookback', () => {
        const now = new Date('2026-11-24T12:00:00Z');
        const activities: UserActivity[] = [];
        for (let d = 0; d < 5; d++) {
            for (let t = 0; t < 12; t++) {
                activities.push({
                    type: 'trade',
                    slug: 'sol-updown-5m-x',
                    timestamp: new Date(now.getTime() - d * 86_400_000 - t * 60_000).toISOString(),
                });
            }
        }
        const cadence = measureActivityCadence(activities, 7, now);
        expect(cadence.tradeCount).toBe(60);
        expect(cadence.activeDays).toBe(5);
        expect(cadence.tradesPerDay).toBeCloseTo(60 / 7);
    });

    it('computes roi and gates', () => {
        expect(computeRoi(50, 400, 500)).toBeCloseTo(0.125);
        const pass = evaluateGates({
            pnlTotal: 50,
            roi: 0.125,
            winRate: 0.6,
            volumeTotal: 500,
            cadence: { tradeCount: 80, activeDays: 5, tradesPerDay: 11, lookbackDays: 7 },
            betsBothSides: false,
            minRoi: 0.1,
            minWinRate: 0.55,
            minVolumeUsd: 100,
            minTradesPerDay: 10,
            minActiveDaysPerWeek: 4,
        });
        expect(pass.pass).toBe(true);

        const fail = evaluateGates({
            pnlTotal: -1,
            roi: 0.2,
            winRate: 0.7,
            volumeTotal: 500,
            cadence: { tradeCount: 80, activeDays: 5, tradesPerDay: 11, lookbackDays: 7 },
            betsBothSides: true,
            minRoi: 0.1,
            minWinRate: 0.55,
            minVolumeUsd: 100,
            minTradesPerDay: 10,
            minActiveDaysPerWeek: 4,
        });
        expect(fail.pass).toBe(false);
        expect(fail.reasons).toEqual(
            expect.arrayContaining(['non_positive_30d_pnl', 'bets_both_sides'])
        );
    });
});
