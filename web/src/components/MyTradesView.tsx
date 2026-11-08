'use client';

import { useEffect, useState, useMemo } from 'react';
import { MyTradesResponse } from '@/types/myTrades';
import { CopyPnLBarChart } from '@/components/charts/CopyPnLBarChart';
import { TradesCountChart } from '@/components/charts/TradesCountChart';
import { CopyTimelineChart } from '@/components/charts/CopyTimelineChart';
import { TradesPieChart } from '@/components/charts/TradesPieChart';
import { MyTradesTable } from '@/components/MyTradesTable';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusBar } from '@/components/StatusBar';
import { buildByTraderStats, summarizeCopyTrades } from '@/lib/copyTradeStats';

type DatePreset = '7d' | '30d' | '90d' | 'all';

export function MyTradesView() {
  const [data, setData] = useState<MyTradesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [customDateFrom, setCustomDateFrom] = useState<string>('');
  const [customDateTo, setCustomDateTo] = useState<string>('');
  const [resetting, setResetting] = useState(false);

  const fetchData = async (refresh = false) => {
    try {
      if (refresh) setRefreshing(true);
      else setLoading(true);

      const url = refresh ? '/api/my-trades?refresh=true' : '/api/my-trades';
      const res = await fetch(url);
      const json = await res.json();

      if (!res.ok) {
        throw new Error(json.error || 'Failed to fetch my trades');
      }

      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const resetPaperStats = async () => {
    if (
      !window.confirm(
        'Reset all paper-mode stats? This deletes paper trades, P/L history, and open paper positions. Cannot be undone.'
      )
    ) {
      return;
    }
    try {
      setResetting(true);
      const res = await fetch('/api/paper/reset', { method: 'POST' });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to reset paper stats');
      }
      await fetchData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset paper stats');
    } finally {
      setResetting(false);
    }
  };

  // Filter trades by date
  const filteredData = useMemo(() => {
    if (!data) return null;

    const allMyTrades = Array.isArray(data.allMyTrades) ? data.allMyTrades : [];
    const traders = Array.isArray(data.traders) ? data.traders : [];
    const myWallet = data.myWallet || 'paper-mode';

    let startTimestamp: number;
    let endTimestamp = Date.now() / 1000;

    if (customDateFrom && customDateTo) {
      startTimestamp = new Date(customDateFrom).getTime() / 1000;
      endTimestamp = new Date(customDateTo).getTime() / 1000 + 86400; // end of day
    } else {
      const now = Date.now() / 1000;
      switch (datePreset) {
        case '7d':
          startTimestamp = now - 7 * 24 * 60 * 60;
          break;
        case '30d':
          startTimestamp = now - 30 * 24 * 60 * 60;
          break;
        case '90d':
          startTimestamp = now - 90 * 24 * 60 * 60;
          break;
        case 'all':
        default:
          startTimestamp = 0;
          break;
      }
    }

    const filteredTrades = allMyTrades.filter(
      (t) => t.timestamp >= startTimestamp && t.timestamp <= endTimestamp
    );

    const paperMode = Boolean(data.paperMode);
    const byTrader = buildByTraderStats(filteredTrades, traders, { paperMode });
    const flow = summarizeCopyTrades(filteredTrades, { paperMode });
    const matchedCount = filteredTrades.filter(
      (t) =>
        (t.agreeingTraders && t.agreeingTraders.length > 0) || Boolean(t.matchedTrader)
    ).length;

    return {
      ...data,
      myWallet,
      traders,
      allMyTrades: filteredTrades,
      byTrader,
      summary: {
        totalTrades: filteredTrades.length,
        totalBought: flow.totalBought,
        totalSold: flow.totalSold,
        matchedTrades: matchedCount,
        unmatchedTrades: filteredTrades.length - matchedCount,
      },
    };
  }, [data, datePreset, customDateFrom, customDateTo]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto"></div>
          <p className="mt-4 text-muted-foreground">Loading your trades...</p>
          <p className="text-sm text-muted-foreground mt-2">
            This may take a moment as we fetch data from Polymarket
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-center max-w-md">
          <h2 className="text-xl font-semibold text-red-500 mb-2">Error</h2>
          <p className="text-muted-foreground mb-4">{error}</p>
          <Button onClick={() => fetchData()}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!filteredData) {
    return null;
  }

  // Use real P&L from positions if available, otherwise fallback to cash flow
  const realPnL = data?.positions?.totalPnL ?? 0;
  const unrealizedPnL = data?.positions?.unrealizedPnL ?? 0;
  const realizedPnL = data?.positions?.realizedPnL ?? 0;
  // Paper: mark-to-market (incl. resolved BUYs without SELL rows). Live: cashflow.
  const cashFlowPnL = filteredData
    ? filteredData.byTrader.reduce((sum, t) => sum + t.pnl, 0)
    : 0;
  const paperMode = Boolean(data?.paperMode);

  const matchRate =
    filteredData.summary.totalTrades > 0
      ? (filteredData.summary.matchedTrades / filteredData.summary.totalTrades) * 100
      : 0;

  return (
    <>
      {/* Status Bar */}
      <StatusBar
        cached={data?.cached}
        cacheDate={data?.cacheDate}
        lastUpdated={data?.analysisDate}
        totalItems={data?.allMyTrades.length}
        itemLabel="trades"
        refreshing={refreshing}
        onRefresh={() => fetchData(true)}
      />

      {data?.paperMode && (
        <Card className="mb-4 p-4 border-yellow-500/40 bg-yellow-500/5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Paper trading ledger</p>
              <p className="text-sm text-muted-foreground mt-1">
                {data.message ||
                  'Accumulated paper entries with the same charts/stats as live My Trades. Expand a wallet below to see which addresses were copied.'}
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={resetPaperStats}
              disabled={resetting}
              className="shrink-0"
            >
              {resetting ? 'Resetting…' : 'Reset paper stats'}
            </Button>
          </div>
        </Card>
      )}

      {/* Date Filter */}
      <Card className="mb-6 p-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <span className="text-sm font-medium">Filter by date:</span>
          <div className="flex gap-2 flex-wrap">
            {(['7d', '30d', '90d', 'all'] as DatePreset[]).map((preset) => (
              <Button
                key={preset}
                variant={datePreset === preset && !customDateFrom ? 'default' : 'outline'}
                size="sm"
                onClick={() => {
                  setDatePreset(preset);
                  setCustomDateFrom('');
                  setCustomDateTo('');
                }}
              >
                {preset === '7d' && '7 Days'}
                {preset === '30d' && '30 Days'}
                {preset === '90d' && '90 Days'}
                {preset === 'all' && 'All Time'}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customDateFrom}
              onChange={(e) => setCustomDateFrom(e.target.value)}
              className="bg-background border rounded px-2 py-1 text-sm"
            />
            <span className="text-muted-foreground">to</span>
            <input
              type="date"
              value={customDateTo}
              onChange={(e) => setCustomDateTo(e.target.value)}
              className="bg-background border rounded px-2 py-1 text-sm"
            />
          </div>
        </div>
      </Card>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">My Wallet</p>
          <p className="text-sm font-mono truncate" title={filteredData.myWallet}>
            {!filteredData.myWallet || filteredData.myWallet === 'paper-mode'
              ? 'Paper mode (no wallet)'
              : `${filteredData.myWallet.slice(0, 8)}...${filteredData.myWallet.slice(-6)}`}
          </p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Total Trades (filtered)</p>
          <p className="text-2xl font-bold">{filteredData.summary.totalTrades}</p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Total Bought</p>
          <p className="text-2xl font-bold">${filteredData.summary.totalBought.toFixed(2)}</p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Match Rate</p>
          <p className="text-2xl font-bold">{matchRate.toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground">
            {filteredData.summary.matchedTrades} / {filteredData.summary.totalTrades}
          </p>
        </div>
      </div>

      {/* P&L Cards - Real data from positions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Total P&L (Real)</p>
          <p
            className={`text-2xl font-bold ${
              realPnL >= 0 ? 'text-green-500' : 'text-red-500'
            }`}
          >
            {realPnL >= 0 ? '+' : '-'}${Math.abs(realPnL).toFixed(2)}
          </p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Unrealized P&L</p>
          <p
            className={`text-2xl font-bold ${
              unrealizedPnL >= 0 ? 'text-green-500' : 'text-red-500'
            }`}
          >
            {unrealizedPnL >= 0 ? '+' : '-'}${Math.abs(unrealizedPnL).toFixed(2)}
          </p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Realized P&L</p>
          <p
            className={`text-2xl font-bold ${
              realizedPnL >= 0 ? 'text-green-500' : 'text-red-500'
            }`}
          >
            {realizedPnL >= 0 ? '+' : '-'}${Math.abs(realizedPnL).toFixed(2)}
          </p>
        </div>
        <div className="bg-card rounded-lg p-4 border">
          <p className="text-sm text-muted-foreground">Positions Value</p>
          <p className="text-2xl font-bold">
            ${(data?.positions?.totalValue ?? 0).toFixed(2)}
          </p>
        </div>
      </div>

      {/* Cash flow / settled proceeds */}
      <Card className="mb-6 p-4">
        <div className="flex items-center gap-4 text-sm flex-wrap">
          <span className="text-muted-foreground">
            {paperMode ? 'Settled P/L (resolved exits):' : 'Cash Flow (Sold - Bought):'}
          </span>
          <span className={cashFlowPnL >= 0 ? 'text-green-500' : 'text-red-500'}>
            {cashFlowPnL >= 0 ? '+' : '-'}${Math.abs(cashFlowPnL).toFixed(2)}
          </span>
          <span className="text-muted-foreground">|</span>
          <span className="text-muted-foreground">
            {paperMode ? 'Exit value (Sold + settled):' : 'Total Sold:'}
          </span>
          <span>${filteredData.summary.totalSold.toFixed(2)}</span>
          <span className="text-muted-foreground">|</span>
          <span className="text-muted-foreground">Open positions:</span>
          <span>{data?.positions?.total ?? 0}</span>
        </div>
      </Card>

      {/* Charts Row 1 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <CopyPnLBarChart byTrader={filteredData.byTrader} />
        <TradesPieChart byTrader={filteredData.byTrader} />
      </div>

      {/* Charts Row 2 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <TradesCountChart byTrader={filteredData.byTrader} />
        <CopyTimelineChart trades={filteredData.allMyTrades} />
      </div>

      {/* Table */}
      <MyTradesTable byTrader={filteredData.byTrader} />
    </>
  );
}
