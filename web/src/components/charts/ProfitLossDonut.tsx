'use client';

import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { TraderAnalysis } from '@/types/trader';
import { TimeRange, filterByTimeRange } from '@/components/TimeRangeFilter';

interface ProfitLossDonutProps {
  traders: TraderAnalysis[];
  timeRange?: TimeRange;
}

export function ProfitLossDonut({ traders, timeRange = 'all' }: ProfitLossDonutProps) {
  // Sum dollar profits vs losses across all attributions (not trader headcount)
  let grossProfit = 0;
  let grossLoss = 0;

  for (const t of traders) {
    const pnl =
      timeRange === 'all'
        ? t.pnl.total
        : (t.dailyBreakdown
            ? filterByTimeRange(t.dailyBreakdown, timeRange, 'date')
            : []
          ).reduce((sum, d) => sum + (d.realizedPnl || 0), 0);
    if (pnl > 0) grossProfit += pnl;
    else if (pnl < 0) grossLoss += Math.abs(pnl);
  }

  const data = [
    { name: 'Profit', value: grossProfit, color: '#22c55e' },
    { name: 'Loss', value: grossLoss, color: '#ef4444' },
  ].filter((d) => d.value > 0);

  const net = grossProfit - grossLoss;

  return (
    <div className="bg-card rounded-xl border p-3 flex flex-col items-center justify-center h-full">
      <span className="text-xs text-muted-foreground mb-1">Total P/L mix</span>
      <div className="relative" style={{ width: 100, height: 80 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.length > 0 ? data : [{ name: 'None', value: 1, color: '#71717a' }]}
              cx="50%"
              cy="50%"
              innerRadius={25}
              outerRadius={38}
              paddingAngle={2}
              dataKey="value"
              startAngle={180}
              endAngle={-180}
            >
              {(data.length > 0 ? data : [{ name: 'None', value: 1, color: '#71717a' }]).map(
                (entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />
                )
              )}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center">
          <span
            className={`text-sm font-bold font-mono ${
              net >= 0 ? 'text-green-500' : 'text-red-500'
            }`}
          >
            {net >= 0 ? '+' : '-'}${Math.abs(net).toFixed(0)}
          </span>
        </div>
      </div>
      <div className="flex gap-2 text-[10px] text-muted-foreground mt-1">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-green-500"></span>$
          {grossProfit.toFixed(0)}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-red-500"></span>$
          {grossLoss.toFixed(0)}
        </span>
      </div>
    </div>
  );
}
