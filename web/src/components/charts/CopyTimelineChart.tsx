'use client';

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { CopyTrade } from '@/types/myTrades';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface CopyTimelineChartProps {
  trades: CopyTrade[];
}

/**
 * Cumulative bot P&L from mark-to-market / resolved `trade.pnl` values.
 * Does NOT use sold−bought cashflow (that treats every BUY as a loss).
 */
export function CopyTimelineChart({ trades }: CopyTimelineChartProps) {
  const withPnl = trades.filter(
    (t) => t.pnl != null && Number.isFinite(t.pnl)
  );

  if (withPnl.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Cumulative P&L Over Time</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">
            No marked P&L yet — this chart uses each trade&apos;s realized /
            unrealized P&L, not buy/sell cashflow.
          </p>
        </CardContent>
      </Card>
    );
  }

  const sorted = [...withPnl].sort((a, b) => a.timestamp - b.timestamp);
  const dailyPnl = new Map<string, number>();

  for (const trade of sorted) {
    const date = new Date(trade.timestamp * 1000).toISOString().split('T')[0];
    dailyPnl.set(date, (dailyPnl.get(date) || 0) + Number(trade.pnl));
  }

  let cumPnL = 0;
  const data = Array.from(dailyPnl.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayPnl]) => {
      cumPnL += dayPnl;
      return {
        date: date.slice(5),
        fullDate: date,
        dailyPnL: Number(dayPnl.toFixed(2)),
        cumPnL: Number(cumPnL.toFixed(2)),
      };
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cumulative P&L Over Time</CardTitle>
        <p className="text-xs text-muted-foreground">
          Running total of bot trade P&L (marked / resolved), not cash in/out
        </p>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <LineChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="date" tick={{ fill: '#888' }} />
            <YAxis
              tick={{ fill: '#888' }}
              tickFormatter={(value) => `$${value}`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: '8px',
                color: '#fff',
              }}
              labelStyle={{ color: '#fff' }}
              itemStyle={{ color: '#fff' }}
              formatter={(value: number, name: string) => [
                `$${value.toFixed(2)}`,
                name,
              ]}
              labelFormatter={(label, payload) => {
                if (payload && payload[0]) {
                  return payload[0].payload.fullDate;
                }
                return label;
              }}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey="cumPnL"
              name="Cumulative P&L"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ fill: '#3b82f6', r: 3 }}
              activeDot={{ r: 5 }}
            />
            <Line
              type="monotone"
              dataKey="dailyPnL"
              name="Daily P&L"
              stroke="#888"
              strokeWidth={1}
              strokeDasharray="5 5"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
