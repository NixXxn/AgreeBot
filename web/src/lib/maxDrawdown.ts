/**
 * Peak-to-trough max drawdown on a chronological P&L equity curve.
 * Starts at `startingEquity` (paper bankroll or live cash), then adds each trade's pnl.
 */
export function computeMaxDrawdown(
  trades: { timestamp: number; pnl?: number | null }[],
  startingEquity = 0
): { maxDrawdownUsd: number; maxDrawdownPct: number; peakEquity: number; troughEquity: number } {
  const withPnl = trades
    .filter((t) => t.pnl != null && Number.isFinite(t.pnl))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  if (withPnl.length === 0) {
    return {
      maxDrawdownUsd: 0,
      maxDrawdownPct: 0,
      peakEquity: startingEquity,
      troughEquity: startingEquity,
    };
  }

  let equity = startingEquity;
  let peak = startingEquity;
  let maxDd = 0;
  let troughAtMax = startingEquity;

  for (const t of withPnl) {
    equity += Number(t.pnl);
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      troughAtMax = equity;
    }
  }

  const maxDrawdownPct = peak > 0 ? (maxDd / peak) * 100 : 0;
  return {
    maxDrawdownUsd: maxDd,
    maxDrawdownPct,
    peakEquity: peak,
    troughEquity: troughAtMax,
  };
}
