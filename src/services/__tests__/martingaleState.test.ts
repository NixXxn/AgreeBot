import * as fs from 'fs';
import * as path from 'path';
import {
    getMartingaleConsecutiveLosses,
    martingaleSharesForStreak,
    positionKey,
    rebuildMartingaleFromResolvedMarks,
    recordMartingaleResult,
    resetMartingaleState,
    syncMartingaleFromPrices,
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

    it('computes share progression', () => {
        expect(martingaleSharesForStreak(0, 5, 8)).toBe(5);
        expect(martingaleSharesForStreak(1, 5, 8)).toBe(10);
        expect(martingaleSharesForStreak(3, 5, 8)).toBe(40);
        expect(martingaleSharesForStreak(99, 5, 3)).toBe(40); // capped at 2^3
    });

    it('resets on win and increments on loss', () => {
        expect(getMartingaleConsecutiveLosses(true)).toBe(0);
        recordMartingaleResult(false, positionKey('c1', 'a1'), true);
        expect(getMartingaleConsecutiveLosses(true)).toBe(1);
        recordMartingaleResult(false, positionKey('c2', 'a2'), true);
        expect(getMartingaleConsecutiveLosses(true)).toBe(2);
        recordMartingaleResult(true, positionKey('c3', 'a3'), true);
        expect(getMartingaleConsecutiveLosses(true)).toBe(0);
    });

    it('is idempotent per position key', () => {
        recordMartingaleResult(false, 'c1:a1', true);
        recordMartingaleResult(false, 'c1:a1', true);
        expect(getMartingaleConsecutiveLosses(true)).toBe(1);
    });

    it('syncs from resolved mark prices', () => {
        syncMartingaleFromPrices(
            [{ conditionId: 'c1', asset: 'tok1', curPrice: 0.005, size: 5 }],
            true
        );
        expect(getMartingaleConsecutiveLosses(true)).toBe(1);
        syncMartingaleFromPrices(
            [{ conditionId: 'c2', asset: 'tok2', curPrice: 0.995, size: 5 }],
            true
        );
        expect(getMartingaleConsecutiveLosses(true)).toBe(0);
    });

    it('computes trailing loss streak from chronological outcomes', () => {
        expect(trailingLossStreak([])).toBe(0);
        expect(trailingLossStreak([{ won: true }])).toBe(0);
        expect(trailingLossStreak([{ won: false }, { won: false }])).toBe(2);
        expect(
            trailingLossStreak([{ won: false }, { won: true }, { won: false }, { won: false }])
        ).toBe(2);
    });

    it('rebuilds paper streak from resolved marks (ignores open)', () => {
        // L, W, L, L → streak 2; open mid-price omitted
        const streak = rebuildMartingaleFromResolvedMarks(
            [
                { conditionId: 'c1', asset: 'a1', curPrice: 0.0 },
                { conditionId: 'c2', asset: 'a2', curPrice: 1.0 },
                { conditionId: 'c3', asset: 'a3', curPrice: 0.5 }, // open — ignored
                { conditionId: 'c4', asset: 'a4', curPrice: 0.0 },
                { conditionId: 'c5', asset: 'a5', curPrice: 0.01 },
            ],
            true
        );
        expect(streak).toBe(2);
        expect(getMartingaleConsecutiveLosses(true)).toBe(2);
    });
});
