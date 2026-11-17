'use client';

import { TraderAnalysis } from '@/types/trader';
import { TimeRange } from '@/components/TimeRangeFilter';

interface WinRateGaugeProps {
  traders: TraderAnalysis[];
  timeRange?: TimeRange;
}

export function WinRateGauge({ traders }: WinRateGaugeProps) {
  // Overall win rate across all bot-copy positions (not average of per-trader rates)
  const totalWins = traders.reduce((sum, t) => sum + t.positions.winners, 0);
  const totalLosses = traders.reduce((sum, t) => sum + t.positions.losers, 0);
  const decided = totalWins + totalLosses;
  const winRate = decided > 0 ? (totalWins / decided) * 100 : 0;

  const size = 120;
  const strokeWidth = 12;
  const radius = (size - strokeWidth) / 2;
  const circumference = Math.PI * radius;
  const progress = (winRate / 100) * circumference;

  const getColor = (rate: number) => {
    if (rate >= 60) return '#22c55e';
    if (rate >= 45) return '#eab308';
    return '#ef4444';
  };

  return (
    <div className="bg-card rounded-xl border p-3 flex flex-col items-center justify-center h-full">
      <span className="text-xs text-muted-foreground mb-1">Win Rate</span>
      <div className="relative" style={{ width: size, height: size / 2 + 10 }}>
        <svg
          width={size}
          height={size / 2 + 10}
          viewBox={`0 0 ${size} ${size / 2 + 10}`}
        >
          <path
            d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
            fill="none"
            stroke="#262626"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
          <path
            d={`M ${strokeWidth / 2} ${size / 2} A ${radius} ${radius} 0 0 1 ${size - strokeWidth / 2} ${size / 2}`}
            fill="none"
            stroke={getColor(winRate)}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${progress} ${circumference}`}
            style={{ transition: 'stroke-dasharray 0.5s ease' }}
          />
        </svg>
        <div className="absolute inset-0 flex items-end justify-center pb-1">
          <span
            className="text-2xl font-bold font-mono"
            style={{ color: getColor(winRate) }}
          >
            {winRate.toFixed(1)}%
          </span>
        </div>
      </div>
      <span className="text-[10px] text-muted-foreground mt-1">
        {totalWins}W / {totalLosses}L overall
      </span>
    </div>
  );
}
