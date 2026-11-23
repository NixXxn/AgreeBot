import * as fs from 'fs';
import * as path from 'path';
import {
    getMartingaleCircle,
    getMartingaleConsecutiveLosses,
    martingaleRecoveryStake,
    martingaleSharesForStreak,
    positionKey,
    rebuildMartingaleFromResolvedMarks,
    recordMartingaleResult,
    resetMartingaleState,
    syncMartingaleFromPrices,
    trailingLossCircle,
    trailingLossStreak,
} from '../martingaleState';

const STATE_PATH = path.join(process.cwd(), 'trader_reports', 'martingale_state.json');

describe('martingaleState', () => {
    beforeEach(() => {
        resetMartingaleState(true);
        resetMartingaleState(false);
    });

    afterAll(() => {
        try {
            if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
        } catch {
            /* ignore */
        }
    });

    it('computes share progression (legacy even-odds)', () => {
        expect(martingaleSharesForStreak(0, 5, 8)).toBe(5);
        expect(martingaleSharesForStreak(1, 5, 8)).toBe(10);
        expect(martingaleSharesForStreak(3, 5, 8)).toBe(40);
        expect(martingaleSharesForStreak(99, 5, 3)).toBe(40); // capped at 2^3
    });

    it('sizes recovery stake from cumulative loss and entry price', () => {
        const fresh = martingaleRecoveryStake({
            baseShares: 5,
            entryPrice: 0.6,
            cumulativeLossUsd: 0,
        });
        expect(fresh.shares).toBeCloseTo(5, 5);
        expect(fresh.stakeUsd).toBeCloseTo(3, 5);

        // Lost $3 @ 0.60; next @ 0.40 → shares = 3/0.6 + 5 = 10, stake = $4
        const next = martingaleRecoveryStake({
            baseShares: 5,
            entryPrice: 0.4,
            cumulativeLossUsd: 3,
        });
        expect(next.shares).toBeCloseTo(10, 5);
        expect(next.stakeUsd).toBeCloseTo(4, 5);
        expect(next.targetProfitUsd).toBeCloseTo(3, 5);
        // Win profit = shares*(1-p) = 10*0.6 = 6 = loss 3 + target 3
        expect(next.shares * (1 - 0.4)).toBeCloseTo(3 + next.targetProfitUsd, 5);
    });

    it('resets on win and accumulates lost USD on loss', () => {
        expect(getMartingaleConsecutiveLosses(true)).toBe(0);
        recordMartingaleResult(false, positionKey('c1', 'a1'), true, 3.0);
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 1,
            cumulativeLossUsd: 3,
        });
        recordMartingaleResult(false, positionKey('c2', 'a2'), true, 4.5);
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 2,
            cumulativeLossUsd: 7.5,
        });
        recordMartingaleResult(true, positionKey('c3', 'a3'), true);
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 0,
            cumulativeLossUsd: 0,
        });
    });

    it('is idempotent per position key', () => {
        recordMartingaleResult(false, 'c1:a1', true, 2);
        recordMartingaleResult(false, 'c1:a1', true, 2);
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 1,
            cumulativeLossUsd: 2,
        });
    });

    it('syncs from resolved mark prices with cost basis', () => {
        syncMartingaleFromPrices(
            [{ conditionId: 'c1', asset: 'tok1', curPrice: 0.005, size: 5, avgPrice: 0.6 }],
            true
        );
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 1,
            cumulativeLossUsd: 3,
        });
        syncMartingaleFromPrices(
            [{ conditionId: 'c2', asset: 'tok2', curPrice: 0.995, size: 5 }],
            true
        );
        expect(getMartingaleCircle(true)).toEqual({
            consecutiveLosses: 0,
            cumulativeLossUsd: 0,
        });
    });

    it('computes trailing loss streak from chronological outcomes', () => {
        expect(trailingLossStreak([])).toBe(0);
        expect(trailingLossStreak([{ won: true }])).toBe(0);
        expect(trailingLossStreak([{ won: false }, { won: false }])).toBe(2);
        expect(
            trailingLossStreak([{ won: false }, { won: true }, { won: false }, { won: false }])
        ).toBe(2);
    });

    it('sums trailing lost stakes for recovery', () => {
        expect(
            trailingLossCircle([
                { won: false, sizeUsd: 3 },
                { won: true, sizeUsd: 2 },
                { won: false, sizeUsd: 4 },
                { won: false, sizeUsd: 1.5 },
            ])
        ).toEqual({ consecutiveLosses: 2, cumulativeLossUsd: 5.5 });
    });

    it('rebuilds paper streak from resolved marks with sizeUsd', () => {
        const circle = rebuildMartingaleFromResolvedMarks(
            [
                { conditionId: 'c1', asset: 'a1', curPrice: 0.0, sizeUsd: 3 },
                { conditionId: 'c2', asset: 'a2', curPrice: 1.0, sizeUsd: 2 },
                { conditionId: 'c3', asset: 'a3', curPrice: 0.5, sizeUsd: 9 }, // open — ignored
                { conditionId: 'c4', asset: 'a4', curPrice: 0.0, sizeUsd: 4 },
                { conditionId: 'c5', asset: 'a5', curPrice: 0.01, sizeUsd: 1.5 },
            ],
            true
        );
        expect(circle).toEqual({ consecutiveLosses: 2, cumulativeLossUsd: 5.5 });
        expect(getMartingaleCircle(true)).toEqual(circle);
    });
});
