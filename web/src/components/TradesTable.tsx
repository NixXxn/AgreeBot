'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { BotTradeRow, TradesResponse } from '@/types/trades';

type FilterMode = 'all' | 'entered' | 'skipped';

export function TradesTable() {
  const [trades, setTrades] = useState<BotTradeRow[]>([]);
  const [summary, setSummary] = useState<TradesResponse['summary']>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const fetchTrades = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const res = await fetch('/api/trades');
      const data: TradesResponse = await res.json();

      if (!res.ok && !Array.isArray(data.trades)) {
        throw new Error(data.error || 'Failed to fetch trades');
      }

      setTrades(Array.isArray(data.trades) ? data.trades : []);
      setSummary(data.summary);
      setError(data.error || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchTrades();
    const id = setInterval(() => fetchTrades(true), 60_000);
    return () => clearInterval(id);
  }, [fetchTrades]);

  const filtered = trades.filter((t) => {
    if (filterMode === 'entered') return t.entered;
    if (filterMode === 'skipped') return !t.entered;
    return true;
  });

  const formatCurrency = (value: number) => {
    const formatted = Math.abs(value).toFixed(2);
    return value >= 0 ? `$${formatted}` : `-$${formatted}`;
  };

  const formatTime = (unix: number) => {
    if (!unix) return '—';
    return new Date(unix * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const shortAddr = (a: string) =>
    a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '—';

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-3">
              Trades
              {summary?.paper ? (
                <Badge variant="warning">Paper</Badge>
              ) : (
                <Badge variant="success">Live</Badge>
              )}
            </CardTitle>
            {summary && (
              <p className="text-sm text-muted-foreground mt-1">
                {summary.entered} entered · {summary.skipped} skipped
                {summary.entered > 0 && (
                  <>
                    {' · '}
                    <span
                      className={
                        summary.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'
                      }
                    >
                      P/L {summary.totalPnl >= 0 ? '+' : ''}
                      {formatCurrency(summary.totalPnl)}
                    </span>
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={filterMode === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilterMode('all')}
            >
              All ({trades.length})
            </Button>
            <Button
              variant={filterMode === 'entered' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilterMode('entered')}
              className="text-green-500 border-green-500/50"
            >
              Entered
            </Button>
            <Button
              variant={filterMode === 'skipped' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilterMode('skipped')}
              className="text-yellow-500 border-yellow-500/50"
            >
              Skipped
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fetchTrades(true)}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-center text-muted-foreground py-8">Loading trades…</p>
        ) : error && filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">{error}</p>
        ) : filtered.length === 0 ? (
          <p className="text-center text-muted-foreground py-8">
            No bot trades yet. Entries accumulate in Mongo + a file ledger when
            consensus fires or expires — they are not cleared when new ones arrive.
            Full stats live under My Trades.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Copied from</TableHead>
                <TableHead className="text-right">Agreed</TableHead>
                <TableHead className="text-center">Entered</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead className="text-right">Entry</TableHead>
                <TableHead className="text-right">Now</TableHead>
                <TableHead className="text-right">P/L</TableHead>
                <TableHead className="text-right">ROI</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((trade) => (
                <TableRow key={trade.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatTime(trade.createdAt)}
                  </TableCell>
                  <TableCell className="max-w-[200px]">
                    <div className="font-medium truncate" title={trade.title}>
                      {trade.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {trade.outcome || '—'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={trade.side === 'BUY' ? 'success' : 'destructive'}>
                      {trade.side}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[180px]">
                    {trade.agreeingTraders.length > 0 ? (
                      <div
                        className="text-xs font-mono text-muted-foreground break-all"
                        title={trade.agreeingTraders.join('\n')}
                      >
                        {trade.agreeingTraders.map(shortAddr).join(', ')}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trade.agreementCount}
                    {trade.minAgreement != null && (
                      <span className="text-muted-foreground text-xs">
                        /{trade.minAgreement}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {!trade.entered ? (
                      <Badge variant="warning">No</Badge>
                    ) : trade.resolved ? (
                      <Badge variant="info">{trade.paper ? 'Paper · Resolved' : 'Resolved'}</Badge>
                    ) : (
                      <Badge variant="success">{trade.paper ? 'Paper' : 'Yes'}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trade.entered ? formatCurrency(trade.sizeUsd) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trade.entryPrice > 0 ? trade.entryPrice.toFixed(3) : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trade.currentPrice != null
                      ? trade.resolved
                        ? trade.currentPrice >= 0.5
                          ? '1.000 ✓'
                          : '0.000 ✗'
                        : trade.currentPrice.toFixed(3)
                      : '—'}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono ${
                      trade.pnl == null
                        ? 'text-muted-foreground'
                        : trade.pnl >= 0
                          ? 'text-green-500'
                          : 'text-red-500'
                    }`}
                  >
                    {trade.pnl == null
                      ? '—'
                      : `${trade.pnl >= 0 ? '+' : ''}${formatCurrency(trade.pnl)}`}
                  </TableCell>
                  <TableCell
                    className={`text-right font-mono ${
                      trade.roi == null
                        ? 'text-muted-foreground'
                        : trade.roi >= 0
                          ? 'text-green-500'
                          : 'text-red-500'
                    }`}
                  >
                    {trade.roi == null
                      ? '—'
                      : `${trade.roi >= 0 ? '+' : ''}${trade.roi.toFixed(1)}%`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
