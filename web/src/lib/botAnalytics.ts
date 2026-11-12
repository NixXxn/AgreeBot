/**
 * Dashboard analytics from THIS bot's ledger only (bot_signals) — never the
 * tracked traders' full Polymarket history or unrelated wallet fills.
 */
import { buildBotTradeRows } from '@/lib/paperLedger';
import { buildByTraderStats, summarizeCopyTrades } from '@/lib/copyTradeStats';
import type { BotTradeRow } from '@/types/trades';
import type { CopyTrade, MyTradesResponse } from '@/types/myTrades';
import type { DailyStats, MonthlyStats, TraderAnalysis } from '@/types/trader';

function shortLabel(address: string): string {
  if (!address || address.length < 10) return address || 'unknown';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().split('T')[0];
}

function toCopyTrades(entered: BotTradeRow[]): CopyTrade[] {
  return entered.map((t) => ({
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
    timeDiff: null,
    agreeingTraders: t.agreeingTraders,
    currentPrice: t.currentPrice,
    pnl: t.pnl,
    roi: t.roi,
    paper: t.paper,
    resolved: t.resolved,
  }));
}

function tradersFromEntered(entered: BotTradeRow[]): { address: string; label: string }[] {
  const walletSet = new Set<string>();
  for (const t of entered) {
    for (const w of t.agreeingTraders) walletSet.add(w.toLowerCase());
  }
  return Array.from(walletSet).map((address) => ({
    address,
    label: shortLabel(address),
  }));
}

/** My Trades payload from bot_signals for the active paper/live ledger. */
export async function buildBotMyTradesResponse(options: {
  paperMode: boolean;
  wallet?: string;
  balanceUsd?: number | null;
}): Promise<MyTradesResponse> {
  const { paperMode, wallet = '', balanceUsd = null } = options;
  const { trades, summary } = await buildBotTradeRows(undefined, { paperMode });
  const entered = trades.filter((t) => t.entered);
  const allMyTrades = toCopyTrades(entered);
  const traders = tradersFromEntered(entered);
  const byTrader = buildByTraderStats(allMyTrades, traders, { paperMode });
  const flow = summarizeCopyTrades(allMyTrades, { paperMode });

  const realized = entered
    .filter((t) => t.resolved && t.pnl != null)
    .reduce((s, t) => s + (t.pnl as number), 0);
  const unrealized = entered
    .filter((t) => !t.resolved && t.pnl != null)
    .reduce((s, t) => s + (t.pnl as number), 0);

  const modeLabel = paperMode ? 'Paper' : 'Live';
  const balMsg =
    balanceUsd != null && Number.isFinite(balanceUsd)
      ? ` · balance $${balanceUsd.toFixed(2)}`
      : '';

  return {
    analysisDate: new Date().toISOString(),
    myWallet: paperMode ? wallet || 'paper-mode' : wallet || '',
    paperMode,
    traders,
    allMyTrades,
    byTrader,
    positions: {
      total: entered.filter((t) => !t.resolved).length,
      totalValue: entered.filter((t) => !t.resolved).reduce((s, t) => s + t.sizeUsd, 0),
      unrealizedPnL: unrealized,
      realizedPnL: realized,
      totalPnL: summary.totalPnl,
    },
    summary: {
      totalTrades: summary.entered,
      totalBought: flow.totalBought,
      totalSold: flow.totalSold,
      matchedTrades: entered.filter((t) => t.agreeingTraders.length > 0).length,
      unmatchedTrades: entered.filter((t) => t.agreeingTraders.length === 0).length,
    },
    balanceUsd: balanceUsd ?? undefined,
    message:
      summary.entered === 0
        ? `${modeLabel} bot ledger is empty — only fills this bot executes appear here.${balMsg}`
        : `${modeLabel} bot ledger: ${summary.entered} entered · ${summary.resolved} resolved · P/L ${
            summary.totalPnl >= 0 ? '+' : ''
          }$${summary.totalPnl.toFixed(2)}${balMsg}`,
  };
}

type AttrBucket = {
  address: string;
  trades: BotTradeRow[];
  /** Proportional share of each trade when multiple wallets agreed */
  shares: number[];
};

/**
 * Homepage trader cards: performance of THIS bot's copies attributed to each
 * agreeing wallet — not that wallet's overall Polymarket PnL.
 */
export async function buildBotCopyTraderAnalyses(options: {
  paperMode: boolean;
  configuredAddresses?: string[];
}): Promise<{ traders: TraderAnalysis[]; message: string }> {
  const { paperMode, configuredAddresses = [] } = options;
  const { trades } = await buildBotTradeRows(undefined, { paperMode });
  const entered = trades.filter((t) => t.entered);

  const buckets = new Map<string, AttrBucket>();
  const ensure = (addr: string) => {
    const key = addr.toLowerCase();
    if (!buckets.has(key)) {
      buckets.set(key, { address: key, trades: [], shares: [] });
    }
    return buckets.get(key)!;
  };

  for (const addr of configuredAddresses) ensure(addr);

  for (const t of entered) {
    const wallets =
      t.agreeingTraders.length > 0
        ? t.agreeingTraders.map((w) => w.toLowerCase())
        : ['unmatched'];
    const share = 1 / wallets.length;
    for (const w of wallets) {
      if (w === 'unmatched') continue;
      const b = ensure(w);
      b.trades.push(t);
      b.shares.push(share);
    }
  }

  const analyses: TraderAnalysis[] = [];
  for (const bucket of buckets.values()) {
    analyses.push(analyzeBucket(bucket));
  }

  analyses.sort((a, b) => b.pnl.total - a.pnl.total);

  const withTrades = analyses.filter((t) => t.trades.total > 0).length;
  return {
    traders: analyses,
    message: `Bot-copy stats only (${withTrades} wallets with fills in ${
      paperMode ? 'paper' : 'live'
    } ledger) — not the traders' full Polymarket history.`,
  };
}

function analyzeBucket(bucket: AttrBucket): TraderAnalysis {
  const { address, trades, shares } = bucket;
  let totalBought = 0;
  let totalSold = 0;
  let buyCount = 0;
  let sellCount = 0;
  let realized = 0;
  let unrealized = 0;
  let open = 0;
  let winners = 0;
  let losers = 0;
  let initialValue = 0;
  let currentValue = 0;

  const monthly = new Map<string, MonthlyStats>();
  const daily = new Map<string, DailyStats>();
  const byMarket = new Map<
    string,
    { title: string; outcome: string; pnl: number; invested: number }
  >();

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const share = shares[i] ?? 1;
    const size = t.sizeUsd * share;
    const pnl = (t.pnl ?? 0) * share;
    const month = formatMonth(t.createdAt);
    const day = formatDate(t.createdAt);

    if (!monthly.has(month)) {
      monthly.set(month, {
        month,
        totalBought: 0,
        totalSold: 0,
        netFlow: 0,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        realizedPnl: 0,
      });
    }
    if (!daily.has(day)) {
      daily.set(day, {
        date: day,
        totalBought: 0,
        totalSold: 0,
        netFlow: 0,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        realizedPnl: 0,
      });
    }
    const m = monthly.get(month)!;
    const d = daily.get(day)!;
    m.tradeCount++;
    d.tradeCount++;

    if (t.side === 'BUY') {
      totalBought += size;
      buyCount++;
      m.totalBought += size;
      m.buyCount++;
      d.totalBought += size;
      d.buyCount++;
      initialValue += size;
      if (!t.resolved) {
        open++;
        currentValue += size + pnl;
        unrealized += pnl;
      } else {
        realized += pnl;
        m.realizedPnl += pnl;
        d.realizedPnl += pnl;
      }
    } else {
      totalSold += size;
      sellCount++;
      m.totalSold += size;
      m.sellCount++;
      d.totalSold += size;
      d.sellCount++;
      realized += pnl;
      m.realizedPnl += pnl;
      d.realizedPnl += pnl;
    }
    m.netFlow = m.totalSold - m.totalBought;
    d.netFlow = d.totalSold - d.totalBought;

    if (t.pnl != null && Number.isFinite(t.pnl)) {
      if (pnl > 0) winners++;
      else if (pnl < 0) losers++;
    }

    const mk = `${t.conditionId}|${t.outcome}`;
    const prev = byMarket.get(mk) || {
      title: t.title || 'Unknown',
      outcome: t.outcome || '',
      pnl: 0,
      invested: 0,
    };
    prev.pnl += pnl;
    if (t.side === 'BUY') prev.invested += size;
    byMarket.set(mk, prev);
  }

  const totalPnL = realized + unrealized;
  const roi = totalBought > 0 ? (totalPnL / totalBought) * 100 : 0;
  const timestamps = trades.map((t) => t.createdAt).filter((t) => t > 0);
  const first = timestamps.length ? Math.min(...timestamps) : 0;
  const last = timestamps.length ? Math.max(...timestamps) : 0;
  const daysActive =
    first && last ? Math.max(1, Math.ceil((last - first) / 86400)) : trades.length > 0 ? 1 : 0;
  const periodMonths = daysActive > 0 ? daysActive / 30.44 : 0;

  const marketRows = Array.from(byMarket.values())
    .map((r) => ({
      title: r.title,
      outcome: r.outcome,
      pnl: r.pnl,
      roi: r.invested > 0 ? (r.pnl / r.invested) * 100 : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);

  return {
    address,
    label: shortLabel(address),
    analysisDate: new Date().toISOString(),
    periodMonths: Number(periodMonths.toFixed(1)),
    trades: {
      total: trades.length,
      buys: buyCount,
      sells: sellCount,
      firstTrade: first ? new Date(first * 1000).toISOString() : '',
      lastTrade: last ? new Date(last * 1000).toISOString() : '',
      daysActive,
    },
    volume: {
      totalBought,
      totalSold,
      netFlow: totalSold - totalBought,
    },
    positions: {
      total: open + winners + losers,
      open,
      winners,
      losers,
      winRate: winners + losers > 0 ? (winners / (winners + losers)) * 100 : 0,
      initialValue,
      currentValue,
    },
    pnl: {
      unrealized,
      realized,
      total: totalPnL,
      roi,
      monthlyRoi: periodMonths > 0 ? roi / periodMonths : 0,
      annualizedRoi: periodMonths > 0 ? (roi / periodMonths) * 12 : 0,
    },
    redeemable: { count: 0, value: 0 },
    monthlyBreakdown: Array.from(monthly.values()).sort((a, b) =>
      a.month.localeCompare(b.month)
    ),
    dailyBreakdown: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
    topWinners: marketRows.filter((r) => r.pnl > 0).slice(0, 5),
    topLosers: marketRows.filter((r) => r.pnl < 0).slice(-5).reverse(),
  };
}
