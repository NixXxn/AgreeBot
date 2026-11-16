/** Step size for the doubling payout ladder ($). */
export const AUTO_CLAIM_STEP = 50;

/** Minimum baseline before claims can fire (100 → 200 pays 50). */
export const AUTO_CLAIM_MIN_BASELINE = AUTO_CLAIM_STEP * 2;

export interface AutoClaimPlan {
    shouldClaim: boolean;
    payout: number;
    newBaseline: number;
    levels: number;
    /** Human label e.g. "100→200" when a claim fires. */
    stage: string | null;
}

/**
 * Snap a cash balance down onto the $50 ladder.
 * Returns 0 if below the minimum claimable baseline ($100).
 */
export const snapBaseline = (
    balance: number,
    step: number = AUTO_CLAIM_STEP
): number => {
    if (!Number.isFinite(balance) || balance < AUTO_CLAIM_MIN_BASELINE) return 0;
    return Math.floor(balance / step) * step;
};

export const formatClaimStage = (baseline: number): string =>
    `${baseline}→${baseline * 2}`;

/**
 * Doubling ladder (live auto-claim) — one stage per claim, never re-fires prior stages:
 *   baseline 100, cash ≥ 200 → pay $50,  baseline → 150
 *   baseline 150, cash ≥ 300 → pay $100, baseline → 200
 *   baseline 200, cash ≥ 400 → pay $150, baseline → 250
 *   baseline 250, cash ≥ 500 → pay $200, baseline → 300
 *
 * Baseline only advances (never ratchets down on losses), so hitting $200 again
 * after a 100→200 payout cannot pay another $50.
 */
export const computeAutoClaim = (
    balance: number,
    baseline: number,
    step: number = AUTO_CLAIM_STEP
): AutoClaimPlan => {
    const noClaim = (b: number): AutoClaimPlan => ({
        shouldClaim: false,
        payout: 0,
        newBaseline: b,
        levels: 0,
        stage: null,
    });

    if (!Number.isFinite(balance) || balance <= 0) {
        return noClaim(Number.isFinite(baseline) ? baseline : 0);
    }

    let b = Number.isFinite(baseline) ? baseline : 0;

    // First run / recovery: park baseline on the ladder without paying out.
    if (b < AUTO_CLAIM_MIN_BASELINE) {
        return noClaim(snapBaseline(balance, step));
    }

    // Losses: keep baseline (do NOT ratchet down — that would re-arm prior stages).
    if (balance + 1e-9 < 2 * b) {
        return noClaim(b);
    }

    // Exactly one stage per run — never cascade through earlier thresholds.
    const chunk = b - step;
    if (chunk <= 0) {
        return noClaim(b);
    }

    const payout = Math.round(chunk * 100) / 100;
    const newBaseline = b + step;

    return {
        shouldClaim: payout >= 0.01,
        payout,
        newBaseline,
        levels: 1,
        stage: formatClaimStage(b),
    };
};
