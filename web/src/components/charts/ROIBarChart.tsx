'use client';

import { TraderAnalysis } from '@/types/trader';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeRange, filterByTimeRange } from '@/components/TimeRangeFilter';

interface ROIBarChartProps {
  traders: TraderAnalysis[];
  compact?: boolean;
  timeRange?: TimeRange;
}

/** Portfolio-level ROI = total P&L / total volume bought (not average of per-trader ROIs). */
export function ROIBarChart({
  traders,
  compact = false,
  timeRange = 'all',
}: ROIBarChartProps) {
  let totalPnL = 0;
  let totalVolume = 0;

  for (const t of traders) {
    if (timeRange === 'all') {
      totalPnL += t.pnl.total;
      totalVolume += t.volume.totalBought;
    } else {
      const filteredDaily = t.dailyBreakdown
        ? filterByTimeRange(t.dailyBreakdown, timeRange, 'date')
        : [];
      totalPnL += filteredDaily.reduce((sum, d) => sum + (d.realizedPnl || 0), 0);
      totalVolume += filteredDaily.reduce((sum, d) => sum + d.totalBought, 0);
    }
  }

  const overallRoi = totalVolume > 0 ? (totalPnL / totalVolume) * 100 : 0;
  const totalWins = traders.reduce((sum, t) => sum + t.positions.winners, 0);
  const totalLosses = traders.reduce((sum, t) => sum + t.positions.losers, 0);
  const decided = totalWins + totalLosses;
  const winRate = decided > 0 ? (totalWins / decided) * 100 : 0;

  return (
    <Card className={compact ? 'h-full' : ''}>
      <CardHeader className={compact ? 'pb-2 pt-3 px-4' : ''}>
        <CardTitle className={compact ? 'text-sm' : ''}>Overall ROI</CardTitle>
      </CardHeader>
      <CardContent
        className={`flex flex-col justify-center gap-4 ${compact ? 'pb-4 px-4' : ''}`}
      >
        <div>
          <p
            className={`font-mono font-bold ${
              overallRoi >= 0 ? 'text-blue-500' : 'text-orange-500'
            } ${compact ? 'text-4xl' : 'text-5xl'}`}
          >
            {overallRoi >= 0 ? '+' : ''}
            {overallRoi.toFixed(1)}%
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Total P&L ÷ total volume bought
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Total P&L</p>
            <p
              className={`font-mono font-semibold ${
                totalPnL >= 0 ? 'text-green-500' : 'text-red-500'
              }`}
            >
              {totalPnL >= 0 ? '+' : '-'}${Math.abs(totalPnL).toFixed(2)}
            </p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs text-muted-foreground">Volume bought</p>
            <p className="font-mono font-semibold">${totalVolume.toFixed(2)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3 col-span-2">
            <p className="text-xs text-muted-foreground">Win rate (all positions)</p>
            <p className="font-mono font-semibold">
              {winRate.toFixed(1)}%{' '}
              <span className="text-muted-foreground font-normal text-xs">
                ({totalWins}W / {totalLosses}L)
              </span>
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
