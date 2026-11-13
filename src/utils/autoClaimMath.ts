/** Step size for the doubling payout ladder ($). */
export const AUTO_CLAIM_STEP = 50;

/** Minimum baseline before claims can fire (100 → 200 pays 50). */
export const AUTO_CLAIM_MIN_BASELINE = AUTO_CLAIM_STEP * 2;

export interface AutoClaimPlan {
    shouldClaim: boolean;
    payout: number;
    newBaseline: number;
    levels: number;
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

/**
 * Doubling ladder (live auto-claim):
 *   baseline 100, balance ≥ 200 → pay 50, baseline → 150
 *   baseline 150, balance ≥ 300 → pay 100, baseline → 200
 *   baseline 200, balance ≥ 400 → pay 150, baseline → 250
 *   …
 *
 * Each level withdraws (baseline − step) and advances baseline by +step.
 * Multiple levels cascade if balance overshoots several thresholds at once.
 */
export const computeAutoClaim = (
    balance: number,
    baseline: number,
    step: number = AUTO_CLAIM_STEP
): AutoClaimPlan => {
    if (!Number.isFinite(balance) || balance <= 0) {
        return { shouldClaim: false, payout: 0, newBaseline: baseline, levels: 0 };
    }

    let b = Number.isFinite(baseline) ? baseline : 0;

    // First run / recovery: park baseline on the ladder without paying out.
    if (b < AUTO_CLAIM_MIN_BASELINE) {
        const snapped = snapBaseline(balance, step);
        return {
            shouldClaim: false,
            payout: 0,
            newBaseline: snapped,
            levels: 0,
        };
    }

    // Losses: ratchet baseline down so the next double is reachable.
    if (balance < b) {
        return {
            shouldClaim: false,
            payout: 0,
            newBaseline: snapBaseline(balance, step),
            levels: 0,
        };
    }

    let bal = balance;
    let payout = 0;
    let levels = 0;

    while (b >= AUTO_CLAIM_MIN_BASELINE && bal + 1e-9 >= 2 * b) {
        const chunk = b - step;
        if (chunk <= 0) break;
        bal -= chunk;
        b += step;
        payout += chunk;
        levels += 1;
        if (levels > 100) break;
    }

    // Round to cents to avoid float dust
    payout = Math.round(payout * 100) / 100;

    return {
        shouldClaim: payout >= 0.01 && levels > 0,
        payout,
        newBaseline: b,
        levels,
    };
};
