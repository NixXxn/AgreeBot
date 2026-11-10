import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { buildPaperMyTradesResponse } from '@/lib/paperLedger';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperMode, resolveProxyWallet } from '@/lib/botMode';
import { buildByTraderStats, summarizeCopyTrades } from '@/lib/copyTradeStats';
import type { CopyTrade, MyTradesResponse } from '@/types/myTrades';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const paperMode = resolvePaperMode(overrides);
    const wallet = resolveProxyWallet(overrides);

    // Paper mode: accumulate from Mongo + JSONL ledger
    if (paperMode) {
      const paper = await buildPaperMyTradesResponse();
      return NextResponse.json(paper);
    }

    // Live mode: prefer Data API for the funder wallet (no local analyze reports required)
    if (wallet) {
      const reportsDir = path.join(process.cwd(), '..', 'trader_reports');
      const myTradesPath = path.join(reportsDir, '_MY_TRADES.json');

      if (fs.existsSync(myTradesPath) && !refresh) {
        try {
          const data = JSON.parse(fs.readFileSync(myTradesPath, 'utf-8'));
          if (data?.myWallet && !data.paperMode) {
            return NextResponse.json({
              ...data,
              cached: true,
              cacheDate: data.analysisDate,
            });
          }
        } catch {
          /* rebuild */
        }
      }

      const live = await buildLiveWalletMyTrades(wallet);
      try {
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(myTradesPath, JSON.stringify(live, null, 2));
      } catch {
        /* cache optional */
      }
      return NextResponse.json(live);
    }

    // No wallet — fall back to any paper ledger history
    const paper = await buildPaperMyTradesResponse();
    if (paper.summary.totalTrades > 0) {
      return NextResponse.json(paper);
    }

    return NextResponse.json(
      {
        error:
          'No POLY_FUNDER / PROXY_WALLET configured. Set the deposit wallet in Coolify for live My Trades.',
      },
      { status: 404 }
    );
  } catch (error) {
    console.error('Error fetching my trades:', error);
    return NextResponse.json(
      { error: 'Failed to fetch my trades' },
      { status: 500 }
    );
  }
}

function unwrapData(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload;
  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { data?: unknown }).data)
  ) {
    return (payload as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

async function fetchPositions(address: string) {
  const url = `https://data-api.polymarket.com/v2/positions?user=${address}&limit=500`;
  const response = await fetch(url, { cache: 'no-store' });
  const payload = await response.json();
  return unwrapData(payload).map((row) => ({
    asset: String(row.token_id ?? row.asset ?? ''),
    conditionId: String(row.condition_id ?? row.conditionId ?? ''),
    size: Number(row.current_size ?? row.size ?? 0),
    avgPrice: Number(row.avg_price ?? row.avgPrice ?? 0),
    initialValue: Number(row.entry_cost_usdc ?? row.initialValue ?? 0),
    currentValue: Number(row.current_value ?? row.currentValue ?? 0),
    cashPnl: Number(row.unrealized_pnl ?? row.cashPnl ?? 0),
    percentPnl: Number(row.percent_pnl ?? row.percentPnl ?? 0),
    realizedPnl: Number(row.realized_pnl ?? row.realizedPnl ?? 0),
    curPrice: Number(row.current_price ?? row.curPrice ?? 0),
    title: String(row.title ?? ''),
    outcome: String(row.outcome ?? ''),
  }));
}

async function fetchTrades(address: string) {
  const allTrades: CopyTrade[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      user: address,
      type: 'TRADE',
      limit: '200',
    });
    if (cursor) params.set('cursor', cursor);

    const url = `https://data-api.polymarket.com/v2/activity?${params.toString()}`;
    const response = await fetch(url, { cache: 'no-store' });
    const payload = await response.json();
    const rows = unwrapData(payload);
    if (rows.length === 0) break;

    for (const row of rows) {
      const sideRaw = String(row.side ?? 'BUY').toUpperCase();
      allTrades.push({
        timestamp: Number(row.timestamp ?? 0),
        side: sideRaw === 'SELL' ? 'SELL' : 'BUY',
        usdcSize: Number(row.usdc_size ?? row.usdcSize ?? 0),
        price: Number(row.price ?? 0),
        title: String(row.title ?? ''),
        outcome: String(row.outcome ?? ''),
        conditionId: String(row.condition_id ?? row.conditionId ?? ''),
        asset: String(row.token_id ?? row.asset ?? ''),
        matchedTrader: null,
        matchedTraderLabel: null,
        timeDiff: null,
        paper: false,
        resolved: false,
      });
    }

    const next =
      payload && typeof payload === 'object'
        ? (payload as { pagination?: { next_cursor?: string | null; has_more?: boolean } })
            .pagination
        : undefined;
    if (!next?.has_more || !next.next_cursor) break;
    cursor = next.next_cursor;
  }

  return allTrades;
}

async function buildLiveWalletMyTrades(wallet: string): Promise<MyTradesResponse> {
  const [allMyTrades, myPositions] = await Promise.all([
    fetchTrades(wallet),
    fetchPositions(wallet),
  ]);

  const totalUnrealizedPnL = myPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const totalRealizedPnL = myPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

  const byTrader = buildByTraderStats(allMyTrades, [], { paperMode: false });
  const flow = summarizeCopyTrades(allMyTrades, { paperMode: false });

  return {
    analysisDate: new Date().toISOString(),
    myWallet: wallet,
    paperMode: false,
    traders: [],
    allMyTrades,
    byTrader,
    positions: {
      total: myPositions.length,
      totalValue: myPositions.reduce((s, p) => s + (p.currentValue || 0), 0),
      unrealizedPnL: totalUnrealizedPnL,
      realizedPnL: totalRealizedPnL,
      totalPnL: totalUnrealizedPnL + totalRealizedPnL,
    },
    summary: {
      totalTrades: allMyTrades.length,
      totalBought: flow.totalBought,
      totalSold: flow.totalSold,
      matchedTrades: 0,
      unmatchedTrades: allMyTrades.length,
    },
    message: `Live wallet ${wallet.slice(0, 8)}… · ${allMyTrades.length} trades from Data API v2`,
  };
}
