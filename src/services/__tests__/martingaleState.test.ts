import * as fs from 'fs';
import * as path from 'path';
import {
    getMartingaleConsecutiveLosses,
    martingaleSharesForStreak,
    positionKey,
    recordMartingaleResult,
    resetMartingaleState,
    syncMartingaleFromPrices,
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
});
