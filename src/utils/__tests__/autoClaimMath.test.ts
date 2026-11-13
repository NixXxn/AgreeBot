import {
    AUTO_CLAIM_MIN_BASELINE,
    AUTO_CLAIM_STEP,
    computeAutoClaim,
    snapBaseline,
} from '../autoClaimMath';

describe('snapBaseline', () => {
    it('snaps down to the $50 ladder', () => {
        expect(snapBaseline(123)).toBe(100);
        expect(snapBaseline(199)).toBe(150);
        expect(snapBaseline(200)).toBe(200);
    });

    it('returns 0 below minimum baseline', () => {
        expect(snapBaseline(99)).toBe(0);
        expect(snapBaseline(50)).toBe(0);
    });
});

describe('computeAutoClaim', () => {
    it('matches the user ladder at exact doubles', () => {
        expect(computeAutoClaim(200, 100)).toEqual({
            shouldClaim: true,
            payout: 50,
            newBaseline: 150,
            levels: 1,
        });
        expect(computeAutoClaim(300, 150)).toEqual({
            shouldClaim: true,
            payout: 100,
            newBaseline: 200,
            levels: 1,
        });
        expect(computeAutoClaim(400, 200)).toEqual({
            shouldClaim: true,
            payout: 150,
            newBaseline: 250,
            levels: 1,
        });
        expect(computeAutoClaim(500, 250)).toEqual({
            shouldClaim: true,
            payout: 200,
            newBaseline: 300,
            levels: 1,
        });
    });

    it('does not claim before 2× baseline', () => {
        expect(computeAutoClaim(199, 100).shouldClaim).toBe(false);
        expect(computeAutoClaim(299, 150).shouldClaim).toBe(false);
    });

    it('cascades multiple levels on overshoot', () => {
        // 100 → jump to 400: pay 50 then 100 → leave 250, baseline 200
        expect(computeAutoClaim(400, 100)).toEqual({
            shouldClaim: true,
            payout: 150,
            newBaseline: 200,
            levels: 2,
        });
    });

    it('initializes baseline without payout when unset', () => {
        const plan = computeAutoClaim(175, 0);
        expect(plan.shouldClaim).toBe(false);
        expect(plan.newBaseline).toBe(150);
        expect(plan.payout).toBe(0);
    });

    it('ratchets baseline down after losses', () => {
        const plan = computeAutoClaim(120, 200);
        expect(plan.shouldClaim).toBe(false);
        expect(plan.newBaseline).toBe(100);
    });

    it('uses configured step constants', () => {
        expect(AUTO_CLAIM_STEP).toBe(50);
        expect(AUTO_CLAIM_MIN_BASELINE).toBe(100);
    });
});
