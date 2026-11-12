import { NextResponse } from 'next/server';
import {
  buildBotTradeRows,
  buildPaperMyTradesResponse,
  type LedgerSignal,
  loadAllSignals,
} from '@/lib/paperLedger';
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

    // Live mode: wallet Data API fills are source of truth; bot_signals add copy attribution.
    const live = await buildLiveMyTrades(wallet);
    return NextResponse.json({
      ...live,
      modeSource: mode.source,
      clobReady: mode.clobReady ?? null,
      refreshed: refresh,
    });
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

function toUnixSeconds(raw: unknown): number {
  if (typeof raw === 'string' && raw.includes('T')) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function shortLabel(address: string): string {
  if (!address || address.length < 10) return address || 'unknown';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

type WalletActivity = {
  timestamp: number;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  conditionId: string;
  asset: string;
};

type WalletPosition = {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  outcome: string;
};

async function fetchWalletActivity(address: string): Promise<WalletActivity[]> {
  const rows: WalletActivity[] = [];
  const pageSize = 100;
  const maxPages = 50; // up to 5k fills
  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const url = `https://data-api.polymarket.com/v2/activity?user=${address}&limit=${pageSize}&offset=${offset}`;
    const chunk = unwrapData(await fetchJson(url));
    if (chunk.length === 0) break;

    for (const row of chunk) {
      const type = String(row.type ?? 'TRADE').toUpperCase();
      if (type && type !== 'TRADE' && type !== 'ORDER_FILLED') continue;
      const side =
        String(row.side ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
      rows.push({
        timestamp: toUnixSeconds(row.timestamp ?? row.block_timestamp),
        side,
        usdcSize: Number(row.usdc_size ?? row.usdcSize ?? 0),
        price: Number(row.price ?? 0),
        title: String(row.title ?? ''),
        outcome: String(row.outcome ?? ''),
        conditionId: String(row.condition_id ?? row.conditionId ?? ''),
        asset: String(row.token_id ?? row.tokenId ?? row.asset ?? ''),
      });
    }
    if (chunk.length < pageSize) break;
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchPositions(address: string): Promise<WalletPosition[]> {
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

type AttrSignal = {
  asset: string;
  conditionId: string;
  side: 'BUY' | 'SELL';
  createdAt: number;
  sizeUsd: number;
  agreeingTraders: string[];
  used: boolean;
};

function toAttrSignals(docs: LedgerSignal[]): AttrSignal[] {
  return docs
    .filter((d) => Boolean(d.entered))
    .map((d) => ({
      asset: String(d.asset || ''),
      conditionId: String(d.conditionId || ''),
      side: (String(d.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as
        | 'BUY'
        | 'SELL',
      createdAt: Number(d.createdAt || 0),
      sizeUsd: Number(d.sizeUsd || 0),
      agreeingTraders: Array.isArray(d.agreeingTraders)
        ? d.agreeingTraders.map(String)
        : [],
      used: false,
    }));
}

/** Match a wallet fill to a bot decision for copy attribution. */
function matchSignal(trade: WalletActivity, signals: AttrSignal[]): AttrSignal | null {
  let best: AttrSignal | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const s of signals) {
    if (s.used || s.side !== trade.side) continue;
    const assetOk =
      (trade.asset && s.asset && trade.asset === s.asset) ||
      (trade.conditionId && s.conditionId && trade.conditionId === s.conditionId);
    if (!assetOk) continue;

    const dt = Math.abs(s.createdAt - trade.timestamp);
    if (dt > 15 * 60) continue; // 15 minutes

    const sizeBase = Math.max(trade.usdcSize, s.sizeUsd, 0.01);
    const sizeDiff = Math.abs(trade.usdcSize - s.sizeUsd) / sizeBase;
    if (sizeDiff > 0.75 && Math.abs(trade.usdcSize - s.sizeUsd) > 5) continue;

    const score = dt + sizeDiff * 60;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }

  if (best) best.used = true;
  return best;
}

function responseFromTrades(
  wallet: string,
  allMyTrades: CopyTrade[],
  positions: WalletPosition[],
  message: string
): MyTradesResponse {
  const walletSet = new Set<string>();
  for (const t of allMyTrades) {
    for (const w of t.agreeingTraders || []) walletSet.add(w.toLowerCase());
    if (t.matchedTrader) walletSet.add(t.matchedTrader.toLowerCase());
  }
  const traders = Array.from(walletSet)
    .filter((a) => a && a !== 'unmatched')
    .map((address) => ({ address, label: shortLabel(address) }));

  const byTrader = buildByTraderStats(allMyTrades, traders, { paperMode: false });
  const flow = summarizeCopyTrades(allMyTrades, { paperMode: false });
  const matched = allMyTrades.filter(
    (t) => (t.agreeingTraders && t.agreeingTraders.length > 0) || t.matchedTrader
  ).length;

  const unrealized = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
  const realized = positions.reduce((s, p) => s + (p.realizedPnl || 0), 0);

  return {
    analysisDate: new Date().toISOString(),
    myWallet: wallet || '',
    paperMode: false,
    traders,
    allMyTrades,
    byTrader,
    positions: {
      total: positions.length,
      totalValue: positions.reduce((s, p) => s + (p.currentValue || 0), 0),
      unrealizedPnL: unrealized,
      realizedPnL: realized,
      totalPnL: unrealized + realized,
    },
    summary: {
      totalTrades: allMyTrades.length,
      totalBought: flow.totalBought,
      totalSold: flow.totalSold,
      matchedTrades: matched,
      unmatchedTrades: allMyTrades.length - matched,
    },
    message,
  };
}

async function buildLiveFromBotSignalsOnly(wallet: string): Promise<MyTradesResponse> {
  // Include entered rows regardless of paper tag — migration moved real rows to paper
  const { trades } = await buildBotTradeRows(undefined, {});
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
        ? t.agreeingTraders.map(shortLabel).join(', ')
        : null,
    agreeingTraders: t.agreeingTraders,
    timeDiff: null,
    paper: t.paper,
    resolved: t.resolved,
    pnl: t.pnl,
    roi: t.roi,
  }));

  return responseFromTrades(
    wallet,
    allMyTrades,
    [],
    `Live bot ledger (${allMyTrades.length} entered) — set POLY_FUNDER for wallet fills`
  );
}

async function buildLiveMyTrades(wallet: string): Promise<MyTradesResponse> {
  if (!wallet) {
    return buildLiveFromBotSignalsOnly('');
  }

  let activity: WalletActivity[] = [];
  let positions: WalletPosition[] = [];
  let dataApiError: string | null = null;

  try {
    [activity, positions] = await Promise.all([
      fetchWalletActivity(wallet),
      fetchPositions(wallet),
    ]);
  } catch (error) {
    dataApiError = error instanceof Error ? error.message : String(error);
    console.warn('Wallet Data API failed for My Trades:', error);
  }

  // Attribution from any entered bot signals (paper or live)
  let signals: AttrSignal[] = [];
  try {
    signals = toAttrSignals(await loadAllSignals());
  } catch (error) {
    console.warn('Could not load bot_signals for attribution:', error);
  }

  if (activity.length > 0) {
    const allMyTrades: CopyTrade[] = activity.map((t) => {
      const match = matchSignal(t, signals);
      const agreeing = match?.agreeingTraders || [];
      return {
        timestamp: t.timestamp,
        side: t.side,
        usdcSize: t.usdcSize,
        price: t.price,
        title: t.title,
        outcome: t.outcome,
        conditionId: t.conditionId,
        asset: t.asset,
        matchedTrader: agreeing[0] || null,
        matchedTraderLabel:
          agreeing.length > 0 ? agreeing.map(shortLabel).join(', ') : null,
        agreeingTraders: agreeing.length > 0 ? agreeing : undefined,
        timeDiff: match ? Math.abs(match.createdAt - t.timestamp) : null,
        paper: false,
      };
    });

    // Add recent live bot fills not yet visible on Data API
    try {
      const { trades: liveBot } = await buildBotTradeRows(undefined, {
        paperMode: false,
      });
      for (const t of liveBot.filter((x) => x.entered)) {
        const already = allMyTrades.some(
          (a) =>
            a.asset === t.asset &&
            a.side === t.side &&
            Math.abs(a.timestamp - t.createdAt) < 120 &&
            Math.abs(a.usdcSize - t.sizeUsd) < 1
        );
        if (already) continue;
        allMyTrades.push({
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
              ? t.agreeingTraders.map(shortLabel).join(', ')
              : null,
          agreeingTraders: t.agreeingTraders,
          timeDiff: null,
          paper: false,
          resolved: t.resolved,
          pnl: t.pnl,
          roi: t.roi,
        });
      }
      allMyTrades.sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      /* optional */
    }

    const matched = allMyTrades.filter(
      (t) => (t.agreeingTraders && t.agreeingTraders.length > 0) || t.matchedTrader
    ).length;

    return responseFromTrades(
      wallet,
      allMyTrades,
      positions,
      `Wallet fills (${allMyTrades.length}) for ${wallet.slice(0, 8)}… · ${matched} matched to bot copies · ${positions.length} open positions`
    );
  }

  // Data API empty/failed — fall back to bot ledger (all entered, any paper tag)
  const fallback = await buildLiveFromBotSignalsOnly(wallet);
  if (positions.length > 0) {
    const unrealized = positions.reduce((s, p) => s + (p.cashPnl || 0), 0);
    const realized = positions.reduce((s, p) => s + (p.realizedPnl || 0), 0);
    fallback.positions = {
      total: positions.length,
      totalValue: positions.reduce((s, p) => s + (p.currentValue || 0), 0),
      unrealizedPnL: unrealized,
      realizedPnL: realized,
      totalPnL: unrealized + realized,
    };
  }
  fallback.message =
    (fallback.message || '') +
    (dataApiError
      ? ` · Data API unavailable (${dataApiError})`
      : ' · no wallet activity returned; showing bot ledger');
  return fallback;
}
