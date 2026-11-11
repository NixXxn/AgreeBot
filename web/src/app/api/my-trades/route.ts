import { NextResponse } from 'next/server';
import { buildBotTradeRows, buildPaperMyTradesResponse } from '@/lib/paperLedger';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperModeAsync, resolveProxyWallet } from '@/lib/botMode';
import { buildByTraderStats, summarizeCopyTrades } from '@/lib/copyTradeStats';
import type { CopyTrade, MyTradesResponse } from '@/types/myTrades';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    const paperMode = mode.paperMode;
    const wallet = resolveProxyWallet(overrides);

    // Paper mode: accumulate from Mongo + JSONL ledger
    if (paperMode) {
      const paper = await buildPaperMyTradesResponse();
      return NextResponse.json({
        ...paper,
        modeSource: mode.source,
      });
    }

    // Live mode: prefer bot's own live signals (what the copy bot actually did).
    // Optionally enrich with Data API wallet positions; never 500 if Data API fails.
    const liveFromBot = await buildLiveFromBotSignals(wallet);
    if (!refresh) {
      try {
        const enriched = await enrichWithDataApi(liveFromBot, wallet);
        return NextResponse.json({
          ...enriched,
          modeSource: mode.source,
          clobReady: mode.clobReady ?? null,
        });
      } catch (error) {
        console.warn('Data API enrich failed, returning bot signals only:', error);
        return NextResponse.json({
          ...liveFromBot,
          modeSource: mode.source,
          clobReady: mode.clobReady ?? null,
          message:
            (liveFromBot.message || '') +
            ' (Data API unavailable — showing bot live signals only)',
        });
      }
    }

    try {
      const enriched = await enrichWithDataApi(liveFromBot, wallet);
      return NextResponse.json({
        ...enriched,
        modeSource: mode.source,
        clobReady: mode.clobReady ?? null,
      });
    } catch (error) {
      console.warn('Data API refresh failed:', error);
      return NextResponse.json({
        ...liveFromBot,
        modeSource: mode.source,
        clobReady: mode.clobReady ?? null,
        message:
          (liveFromBot.message || '') +
          ' (Data API unavailable — showing bot live signals only)',
      });
    }
  } catch (error) {
    console.error('Error fetching my trades:', error);
    // Last resort: paper ledger so the tab still loads
    try {
      const paper = await buildPaperMyTradesResponse();
      return NextResponse.json({
        ...paper,
        error:
          error instanceof Error ? error.message : 'Failed to fetch my trades',
        message: 'Fell back to paper ledger after live fetch error',
      });
    } catch {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : 'Failed to fetch my trades',
        },
        { status: 500 }
      );
    }
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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Bad JSON from ${url} (${response.status})`);
  }
  if (!response.ok) {
    const errMsg =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(`Data API error: ${errMsg}`);
  }
  return payload;
}

async function fetchPositions(address: string) {
  const url = `https://data-api.polymarket.com/v2/positions?user=${address}&limit=500`;
  const payload = await fetchJson(url);
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

async function buildLiveFromBotSignals(wallet: string): Promise<MyTradesResponse> {
  const { trades } = await buildBotTradeRows(undefined, {
    paperMode: false,
  });
  const entered = trades.filter((t) => t.entered);

  const allMyTrades: CopyTrade[] = entered.map((t) => ({
    timestamp: t.createdAt,
    side: t.side,
    usdcSize: t.sizeUsd,
    price: t.entryPrice,
    title: t.title,
    outcome: t.outcome,
    conditionId: t.conditionId,
    asset: t.asset,
    matchedTrader: t.agreeingTraders[0] || null,
    matchedTraderLabel:
      t.agreeingTraders.length > 0
        ? t.agreeingTraders.map((a) => `0x…${a.slice(-4)}`).join(', ')
        : null,
    timeDiff: null,
    paper: false,
    resolved: t.resolved,
    pnl: t.pnl,
  }));

  const byTrader = buildByTraderStats(allMyTrades, [], { paperMode: false });
  const flow = summarizeCopyTrades(allMyTrades, { paperMode: false });

  return {
    analysisDate: new Date().toISOString(),
    myWallet: wallet || '',
    paperMode: false,
    traders: [],
    allMyTrades,
    byTrader,
    positions: {
      total: 0,
      totalValue: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: flow.pnl,
    },
    summary: {
      totalTrades: allMyTrades.length,
      totalBought: flow.totalBought,
      totalSold: flow.totalSold,
      matchedTrades: allMyTrades.filter((t) => t.matchedTrader).length,
      unmatchedTrades: allMyTrades.filter((t) => !t.matchedTrader).length,
    },
    message: wallet
      ? `Live bot signals (${allMyTrades.length} entered) for ${wallet.slice(0, 8)}…`
      : `Live bot signals (${allMyTrades.length} entered) — set POLY_FUNDER for wallet positions`,
  };
}

async function enrichWithDataApi(
  base: MyTradesResponse,
  wallet: string
): Promise<MyTradesResponse> {
  if (!wallet) return base;

  const myPositions = await fetchPositions(wallet);
  const totalUnrealizedPnL = myPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const totalRealizedPnL = myPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);

  return {
    ...base,
    positions: {
      total: myPositions.length,
      totalValue: myPositions.reduce((s, p) => s + (p.currentValue || 0), 0),
      unrealizedPnL: totalUnrealizedPnL,
      realizedPnL: totalRealizedPnL,
      totalPnL: totalUnrealizedPnL + totalRealizedPnL,
    },
    message: `${base.message || ''} · ${myPositions.length} open positions from Data API`,
  };
}
