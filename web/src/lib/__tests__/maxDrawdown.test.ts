import { computeMaxDrawdown } from '../maxDrawdown';

describe('computeMaxDrawdown', () => {
  it('returns zero with no trades', () => {
    expect(computeMaxDrawdown([], 150)).toEqual({
      maxDrawdownUsd: 0,
      maxDrawdownPct: 0,
      peakEquity: 150,
      troughEquity: 150,
    });
  });

  it('tracks peak-to-trough on cumulative P&L', () => {
    const trades = [
      { timestamp: 1, pnl: 10 },
      { timestamp: 2, pnl: -40 },
      { timestamp: 3, pnl: 5 },
    ];
    // equity: 100 → 110 → 70 → 75; peak 110; max DD = 40
    const dd = computeMaxDrawdown(trades, 100);
    expect(dd.maxDrawdownUsd).toBe(40);
    expect(dd.maxDrawdownPct).toBeCloseTo((40 / 110) * 100, 5);
    expect(dd.peakEquity).toBe(110);
    expect(dd.troughEquity).toBe(70);
  });
});
