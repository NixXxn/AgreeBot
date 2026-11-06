import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './mongo';
import { computePnL, resolveTokenPrice, type PriceInfo } from './tokenPrice';
import type { BotTradeRow } from '@/types/trades';
import type { CopyTrade, MyTradesResponse, TraderCopyStats } from '@/types/myTrades';

const LEDGER_PATH = path.join(process.cwd(), '..', 'trader_reports', 'paper_ledger.jsonl');

export interface LedgerSignal {
  _id?: string;
  conditionId?: string;
  asset?: string;
  side?: string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
  entryPrice?: number;
  sizeUsd?: number;
  agreementCount?: number;
  agreeingTraders?: string[];
  entered?: boolean;
  paper?: boolean;
  reason?: string;
  minAgreement?: number;
  createdAt?: number;
}

function shortLabel(address: string): string {
  if (!address || address.length < 10) return address || 'unknown';
  return `0x…${address.slice(-4)}`;
}

/** Load append-only JSONL backup written by the bot (survives some Mongo wipes). */
export function readLedgerFile(): LedgerSignal[] {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return [];
    const lines = fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n').filter(Boolean);
    const rows: LedgerSignal[] = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as LedgerSignal);
      } catch {
        /* skip bad line */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export async function loadAllSignals(): Promise<LedgerSignal[]> {
  const fromFile = readLedgerFile();
  let fromMongo: LedgerSignal[] = [];

  try {
    const db = await getDb();
    if (db) {
      fromMongo = (await db
        .collection('bot_signals')
        .find({})
        .sort({ createdAt: -1 })
        .limit(5000)
        .toArray()) as unknown as LedgerSignal[];
    }
  } catch (error) {
    console.error('Mongo bot_signals read failed:', error);
  }

  // Merge by stable key — prefer Mongo doc, keep file-only history
  const map = new Map<string, LedgerSignal>();
  const keyOf = (s: LedgerSignal) =>
    String(
      s._id ||
        `${s.createdAt}|${s.asset}|${s.side}|${s.sizeUsd}|${(s.agreeingTraders || []).join(',')}`
    );

  for (const s of fromFile) map.set(keyOf(s), s);
  for (const s of fromMongo) map.set(keyOf(s), s);

  return Array.from(map.values()).sort(
    (a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)
  );
}

async function priceMapFor(
  signals: LedgerSignal[]
): Promise<Map<string, PriceInfo>> {
  const entered = signals.filter((s) => s.entered && s.asset);
  const unique = Array.from(
    new Map(
      entered.map((s) => [
        String(s.asset),
        {
          asset: String(s.asset),
          conditionId: String(s.conditionId || ''),
          outcome: String(s.outcome || ''),
        },
      ])
    ).values()
  ).slice(0, 80);

  const priceMap = new Map<string, PriceInfo>();
  await Promise.all(
    unique.map(async ({ asset, conditionId, outcome }) => {
      priceMap.set(asset, await resolveTokenPrice(asset, conditionId, outcome));
    })
  );
  return priceMap;
}

export async function buildBotTradeRows(signals?: LedgerSignal[]): Promise<{
  trades: BotTradeRow[];
  summary: {
    total: number;
    entered: number;
    skipped: number;
    totalPnl: number;
    paper: boolean;
    resolved: number;
  };
}> {
  const docs = signals ?? (await loadAllSignals());
  const prices = await priceMapFor(docs);

  const trades: BotTradeRow[] = docs.map((d) => {
    const side = (String(d.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as
      | 'BUY'
      | 'SELL';
    const entryPrice = Number(d.entryPrice || 0);
    const sizeUsd = Number(d.sizeUsd || 0);
    const entered = Boolean(d.entered);
    const info = entered ? prices.get(String(d.asset)) : undefined;
    const currentPrice = info?.price ?? null;
    const resolved = Boolean(info?.resolved);
    const { pnl, roi } = computePnL(side, entryPrice, currentPrice, sizeUsd, entered);
    const agreeing = Array.isArray(d.agreeingTraders)
      ? d.agreeingTraders.map(String)
      : [];

    return {
      id: String(d._id || keyFallback(d)),
      createdAt: Number(d.createdAt || 0),
      conditionId: String(d.conditionId || ''),
      asset: String(d.asset || ''),
      side,
      title: String(d.title || d.slug || d.eventSlug || 'Unknown market'),
      slug: String(d.slug || d.eventSlug || ''),
      outcome: String(d.outcome || ''),
      entryPrice,
      currentPrice,
      sizeUsd,
      agreementCount: Number(d.agreementCount || agreeing.length || 0),
      agreeingTraders: agreeing,
      entered,
      paper: Boolean(d.paper),
      reason: String(d.reason || ''),
      minAgreement:
        d.minAgreement !== undefined && d.minAgreement !== null
          ? Number(d.minAgreement)
          : null,
      pnl,
      roi,
      resolved,
    };
  });

  const entered = trades.filter((t) => t.entered);
  return {
    trades,
    summary: {
      total: trades.length,
      entered: entered.length,
      skipped: trades.length - entered.length,
      totalPnl: entered.reduce((s, t) => s + (t.pnl ?? 0), 0),
      paper: trades.some((t) => t.paper) || entered.length > 0,
      resolved: entered.filter((t) => t.resolved).length,
    },
  };
}

function keyFallback(d: LedgerSignal): string {
  return `${d.createdAt}|${d.asset}|${d.side}|${d.sizeUsd}`;
}

/**
 * Shape paper/bot signals into the same payload My Trades charts already consume.
 */
export async function buildPaperMyTradesResponse(): Promise<MyTradesResponse> {
  const { trades, summary } = await buildBotTradeRows();
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
    timeDiff: null,
    agreeingTraders: t.agreeingTraders,
    currentPrice: t.currentPrice,
    pnl: t.pnl,
    roi: t.roi,
    paper: t.paper,
    resolved: t.resolved,
  }));

  // Unique wallets we copied from
  const walletSet = new Set<string>();
  for (const t of entered) {
    for (const w of t.agreeingTraders) walletSet.add(w.toLowerCase());
  }
  const traders = Array.from(walletSet).map((address) => ({
    address,
    label: shortLabel(address),
  }));

  const byTraderMap = new Map<string, CopyTrade[]>();
  for (const trader of traders) byTraderMap.set(trader.address, []);

  for (const trade of allMyTrades) {
    const wallets =
      trade.agreeingTraders && trade.agreeingTraders.length > 0
        ? trade.agreeingTraders
        : trade.matchedTrader
          ? [trade.matchedTrader]
          : [];
    for (const w of wallets) {
      const key = w.toLowerCase();
      const list = byTraderMap.get(key) || [];
      list.push(trade);
      byTraderMap.set(key, list);
    }
  }

  const byTrader: TraderCopyStats[] = traders
    .map((trader) => {
      const list = byTraderMap.get(trader.address) || [];
      let totalBought = 0;
      let totalSold = 0;
      let pnl = 0;
      for (const trade of list) {
        // Proportional attribution across agreeing wallets
        const share = 1 / Math.max(trade.agreeingTraders?.length || 1, 1);
        if (trade.side === 'BUY') totalBought += trade.usdcSize * share;
        else totalSold += trade.usdcSize * share;
        pnl += (trade.pnl ?? 0) * share;
      }
      return {
        traderAddress: trader.address,
        traderLabel: trader.label,
        trades: list,
        totalBought,
        totalSold,
        tradeCount: list.length,
        pnl,
        roi: totalBought > 0 ? (pnl / totalBought) * 100 : 0,
      };
    })
    .sort((a, b) => b.tradeCount - a.tradeCount);

  const realized = entered
    .filter((t) => t.resolved && t.pnl != null)
    .reduce((s, t) => s + (t.pnl as number), 0);
  const unrealized = entered
    .filter((t) => !t.resolved && t.pnl != null)
    .reduce((s, t) => s + (t.pnl as number), 0);

  return {
    analysisDate: new Date().toISOString(),
    myWallet: 'paper-mode',
    paperMode: true,
    traders,
    allMyTrades,
    byTrader,
    positions: {
      total: entered.filter((t) => !t.resolved).length,
      totalValue: entered
        .filter((t) => !t.resolved)
        .reduce((s, t) => s + t.sizeUsd, 0),
      unrealizedPnL: unrealized,
      realizedPnL: realized,
      totalPnL: summary.totalPnl,
    },
    summary: {
      totalTrades: summary.entered,
      totalBought: entered
        .filter((t) => t.side === 'BUY')
        .reduce((s, t) => s + t.sizeUsd, 0),
      totalSold: entered
        .filter((t) => t.side === 'SELL')
        .reduce((s, t) => s + t.sizeUsd, 0),
      matchedTrades: entered.filter((t) => t.agreeingTraders.length > 0).length,
      unmatchedTrades: entered.filter((t) => t.agreeingTraders.length === 0).length,
    },
    message:
      summary.entered === 0
        ? 'No paper entries yet. When consensus fires, trades accumulate here permanently.'
        : `Paper ledger: ${summary.entered} entered · ${summary.resolved} resolved · P/L ${summary.totalPnl >= 0 ? '+' : ''}$${summary.totalPnl.toFixed(2)}`,
  };
}
