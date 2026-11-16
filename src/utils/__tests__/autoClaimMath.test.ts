import {
    AUTO_CLAIM_MIN_BASELINE,
    AUTO_CLAIM_STEP,
    computeAutoClaim,
    formatClaimStage,
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
    it('matches the user ladder at exact doubles (one stage each)', () => {
        expect(computeAutoClaim(200, 100)).toEqual({
            shouldClaim: true,
            payout: 50,
            newBaseline: 150,
            levels: 1,
            stage: '100→200',
        });
        expect(computeAutoClaim(300, 150)).toEqual({
            shouldClaim: true,
            payout: 100,
            newBaseline: 200,
            levels: 1,
            stage: '150→300',
        });
        expect(computeAutoClaim(400, 200)).toEqual({
            shouldClaim: true,
            payout: 150,
            newBaseline: 250,
            levels: 1,
            stage: '200→400',
        });
        expect(computeAutoClaim(500, 250)).toEqual({
            shouldClaim: true,
            payout: 200,
            newBaseline: 300,
            levels: 1,
            stage: '250→500',
        });
    });

    it('does not claim before 2× baseline', () => {
        expect(computeAutoClaim(199, 100).shouldClaim).toBe(false);
        expect(computeAutoClaim(299, 150).shouldClaim).toBe(false);
        expect(computeAutoClaim(200, 150).shouldClaim).toBe(false);
    });

    it('does not re-fire a previous stage after baseline advanced', () => {
        // Already paid 100→200; cash sitting at 200 again must NOT pay $50
        expect(computeAutoClaim(200, 150)).toEqual({
            shouldClaim: false,
            payout: 0,
            newBaseline: 150,
            levels: 0,
            stage: null,
        });
        // Still below next threshold 300
        expect(computeAutoClaim(250, 150).shouldClaim).toBe(false);
    });

    it('fires only one stage even on large overshoot (no cascade)', () => {
        // Cash jumped 100 → 400: only pay the current stage ($50), advance to 150
        expect(computeAutoClaim(400, 100)).toEqual({
            shouldClaim: true,
            payout: 50,
            newBaseline: 150,
            levels: 1,
            stage: '100→200',
        });
        // Next check with remaining ~350 would then hit 150→300
        expect(computeAutoClaim(350, 150)).toEqual({
            shouldClaim: true,
            payout: 100,
            newBaseline: 200,
            levels: 1,
            stage: '150→300',
        });
    });

    it('does not ratchet baseline down after losses (prevents re-arming stages)', () => {
        const plan = computeAutoClaim(120, 200);
        expect(plan.shouldClaim).toBe(false);
        expect(plan.newBaseline).toBe(200);
        // Later cash returns to 200 — still must not re-fire 100→200
        expect(computeAutoClaim(200, 200).shouldClaim).toBe(false);
        // Next claim only at 400
        expect(computeAutoClaim(400, 200).stage).toBe('200→400');
    });

    it('initializes baseline without payout when unset', () => {
        const plan = computeAutoClaim(175, 0);
        expect(plan.shouldClaim).toBe(false);
        expect(plan.newBaseline).toBe(150);
        expect(plan.payout).toBe(0);
        expect(plan.stage).toBeNull();
    });

    it('formats stage labels', () => {
        expect(formatClaimStage(100)).toBe('100→200');
        expect(formatClaimStage(250)).toBe('250→500');
    });

    it('uses configured step constants', () => {
        expect(AUTO_CLAIM_STEP).toBe(50);
        expect(AUTO_CLAIM_MIN_BASELINE).toBe(100);
    });
});
