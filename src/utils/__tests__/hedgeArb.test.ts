import {
    computeHedgeArbPlan,
    findOppositePosition,
    floorToTick,
} from '../hedgeArb';

describe('computeHedgeArbPlan', () => {
    it('allows normal buys when no opposite held', () => {
        const plan = computeHedgeArbPlan(0, 0.55);
        expect(plan.isHedge).toBe(false);
        expect(plan.allowMarket).toBe(true);
        expect(plan.skip).toBe(false);
    });

    it('blocks the magic/fnatic-style 49¢+59¢ hedge', () => {
        const plan = computeHedgeArbPlan(0.49, 0.59);
        expect(plan.isHedge).toBe(true);
        expect(plan.allowMarket).toBe(false);
        expect(plan.skip).toBe(false);
        expect(plan.maxLimitPrice).toBeCloseTo(0.41, 5);
    });

    it('allows market hedge when both legs under 90¢ and sum ≤ 90¢', () => {
        const plan = computeHedgeArbPlan(0.4, 0.45);
        expect(plan.allowMarket).toBe(true);
        expect(plan.skip).toBe(false);
    });

    it('skips when held leg alone is ≥ 90¢', () => {
        const plan = computeHedgeArbPlan(0.92, 0.05);
        expect(plan.skip).toBe(true);
        expect(plan.allowMarket).toBe(false);
    });
});

describe('floorToTick', () => {
    it('rounds down to cents', () => {
        expect(floorToTick(0.419)).toBe(0.41);
        expect(floorToTick(0.41)).toBe(0.41);
    });
});

describe('findOppositePosition', () => {
    it('finds other outcome on same condition', () => {
        const opp = findOppositePosition(
            [
                { asset: 'a', conditionId: 'c1', size: 10, avgPrice: 0.4 },
                { asset: 'b', conditionId: 'c1', size: 5, avgPrice: 0.5 },
            ],
            'c1',
            'a'
        );
        expect(opp?.asset).toBe('b');
    });
});
