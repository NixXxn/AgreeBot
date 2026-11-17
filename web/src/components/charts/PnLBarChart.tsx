'use client';

import { TraderAnalysis } from '@/types/trader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeRange, filterByTimeRange } from '@/components/TimeRangeFilter';

interface PnLBarChartProps {
  traders: TraderAnalysis[];
  compact?: boolean;
  timeRange?: TimeRange;
}

function traderRangePnl(t: TraderAnalysis, timeRange: TimeRange): number {
  if (timeRange === 'all') return t.pnl.total;
  const filteredDaily = t.dailyBreakdown
    ? filterByTimeRange(t.dailyBreakdown, timeRange, 'date')
    : [];
  return filteredDaily.reduce((sum, d) => sum + (d.realizedPnl || 0), 0);
}

/** Portfolio-level P&L totals (sum across all bot-copy attributions). */
export function PnLBarChart({
  traders,
  compact = false,
  timeRange = 'all',
}: PnLBarChartProps) {
  const totalPnL = traders.reduce((sum, t) => sum + traderRangePnl(t, timeRange), 0);
  const totalRealized = traders.reduce((sum, t) => {
    if (timeRange === 'all') return sum + t.pnl.realized;
    return sum + traderRangePnl(t, timeRange);
  }, 0);
  const totalUnrealized =
    timeRange === 'all'
      ? traders.reduce((sum, t) => sum + t.pnl.unrealized, 0)
      : 0;
  const grossProfit = traders.reduce((sum, t) => {
    const p = traderRangePnl(t, timeRange);
    return sum + (p > 0 ? p : 0);
  }, 0);
  const grossLoss = traders.reduce((sum, t) => {
    const p = traderRangePnl(t, timeRange);
    return sum + (p < 0 ? p : 0);
  }, 0);

  return (
    <Card className={compact ? 'h-full' : ''}>
      <CardHeader className={compact ? 'pb-2 pt-3 px-4' : ''}>
        <CardTitle className={compact ? 'text-sm' : ''}>Total P&L</CardTitle>
      </CardHeader>
      <CardContent
        className={`flex flex-col justify-center gap-4 ${compact ? 'pb-4 px-4' : ''}`}
      >
        <div>
          <p
            className={`font-mono font-bold ${
              totalPnL >= 0 ? 'text-green-500' : 'text-red-500'
            } ${compact ? 'text-4xl' : 'text-5xl'}`}
          >
            {totalPnL >= 0 ? '+' : '-'}$
            {Math.abs(totalPnL).toLocaleString('en-US', {
              maximumFractionDigits: 2,
            })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Overall bot-copy profit (all wallets summed)
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Realized</p>
            <p
              className={`font-mono font-semibold ${
                totalRealized >= 0 ? 'text-green-500' : 'text-red-500'
              }`}
            >
              {totalRealized >= 0 ? '+' : '-'}$
              {Math.abs(totalRealized).toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">
              {timeRange === 'all' ? 'Unrealized' : 'Gross profit'}
            </p>
            <p
              className={`font-mono font-semibold ${
                (timeRange === 'all' ? totalUnrealized : grossProfit) >= 0
                  ? 'text-green-500'
                  : 'text-red-500'
              }`}
            >
              {timeRange === 'all' ? (
                <>
                  {totalUnrealized >= 0 ? '+' : '-'}$
                  {Math.abs(totalUnrealized).toFixed(2)}
                </>
              ) : (
                <>+${grossProfit.toFixed(2)}</>
              )}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Gross profit</p>
            <p className="font-mono font-semibold text-green-500">
              +${grossProfit.toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Gross loss</p>
            <p className="font-mono font-semibold text-red-500">
              -${Math.abs(grossLoss).toFixed(2)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
