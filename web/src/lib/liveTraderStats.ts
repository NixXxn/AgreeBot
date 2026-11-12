import type { DailyStats, MonthlyStats, TraderAnalysis } from '@/types/trader';
import { getDb } from './mongo';

const DATA_API_V2 = 'https://data-api.polymarket.com/v2';
const ACTIVITY_PAGE = 100;
/** Hard ceiling per wallet so a bad API can't loop forever (100 × 500 = 50k trades). */
const MAX_ACTIVITY_PAGES = 500;
const CONCURRENCY = 4;
const ACTIVITY_COLLECTION = 'trader_activity';
const STATS_COLLECTION = 'trader_stats_cache';

type Json = Record<string, unknown>;

function unwrapList(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload as Json[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as Json).data)) {
    return (payload as Json).data as Json[];
  }
  return [];
}

function num(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && !Number.isNaN(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isNaN(n) ? fallback : n;
  }
  return fallback;
}

function str(v: unknown, fallback = ''): string {
  return v === null || v === undefined ? fallback : String(v);
}

/** Normalize unix seconds / ms / ISO into unix seconds. */
function toUnixSeconds(raw: unknown): number {
  if (typeof raw === 'string' && raw.includes('T')) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  const n = num(raw);
  if (!n) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

function shortLabel(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatMonth(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  return new Date(ts * 1000).toISOString().split('T')[0];
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
    throw new Error(`Data API ${response.status} for ${url}`);
  }
  return payload;
}

type ActivityRow = {
  timestamp: number;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  asset: string;
  title: string;
  outcome: string;
};

type PositionRow = {
  title: string;
  outcome: string;
  size: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  redeemable: boolean;
};

function activityKey(row: ActivityRow): string {
  return `${row.timestamp}|${row.asset}|${row.side}|${row.usdcSize}|${row.price}`;
}

function parseActivityRow(row: Json): ActivityRow | null {
  const type = str(row.type, 'TRADE').toUpperCase();
  if (type && type !== 'TRADE' && type !== 'ORDER_FILLED') return null;
  const side = str(row.side, 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  return {
    timestamp: toUnixSeconds(row.timestamp ?? row.block_timestamp),
    side,
    usdcSize: num(row.usdc_size ?? row.usdcSize),
    price: num(row.price),
    asset: str(row.token_id ?? row.tokenId ?? row.asset),
    title: str(row.title),
    outcome: str(row.outcome),
  };
}

async function loadStoredActivity(address: string): Promise<ActivityRow[]> {
  try {
    const db = await getDb();
    if (!db) return [];
    const doc = (await db.collection(ACTIVITY_COLLECTION).findOne({
      _id: address,
    } as never)) as unknown as { trades?: ActivityRow[] } | null;
    if (!doc || !Array.isArray(doc.trades)) return [];
    return doc.trades.filter((t) => t && Number(t.timestamp) > 0);
  } catch (error) {
    console.warn(`Failed to load stored activity for ${address}:`, error);
    return [];
  }
}

async function saveStoredActivity(address: string, trades: ActivityRow[]): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection(ACTIVITY_COLLECTION).updateOne(
      { _id: address } as never,
      {
        $set: {
          trades,
          tradeCount: trades.length,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn(`Failed to save activity for ${address}:`, error);
  }
}

async function loadCachedStats(address: string): Promise<TraderAnalysis | null> {
  try {
    const db = await getDb();
    if (!db) return null;
    const doc = (await db.collection(STATS_COLLECTION).findOne({
      _id: address,
    } as never)) as unknown as { report?: TraderAnalysis } | null;
    if (!doc?.report) return null;
    return doc.report;
  } catch {
    return null;
  }
}

async function saveCachedStats(report: TraderAnalysis): Promise<void> {
  try {
    const db = await getDb();
    if (!db) return;
    await db.collection(STATS_COLLECTION).updateOne(
      { _id: report.address } as never,
      {
        $set: {
          report,
          tradeCount: report.trades.total,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (error) {
    console.warn(`Failed to cache stats for ${report.address}:`, error);
  }
}

/**
 * Pull Data API activity (newest first), merge with Mongo history, never drop old rows.
 * Stops paging early once a full page is already known (overlap with stored history).
 */
async function fetchAndMergeActivity(address: string): Promise<ActivityRow[]> {
  const stored = await loadStoredActivity(address);
  const byKey = new Map<string, ActivityRow>();
  for (const row of stored) byKey.set(activityKey(row), row);

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
    const offset = page * ACTIVITY_PAGE;
    const url = `${DATA_API_V2}/activity?user=${address}&limit=${ACTIVITY_PAGE}&offset=${offset}`;
    const chunk = unwrapList(await fetchJson(url));
    if (chunk.length === 0) break;

    let newOnPage = 0;
    for (const raw of chunk) {
      const row = parseActivityRow(raw);
      if (!row || !row.timestamp) continue;
      const key = activityKey(row);
      if (!byKey.has(key)) {
        byKey.set(key, row);
        newOnPage++;
      }
    }

    // Entire page already in Mongo → older pages are already stored
    if (stored.length > 0 && newOnPage === 0) break;
    if (chunk.length < ACTIVITY_PAGE) break;
  }

  const merged = Array.from(byKey.values()).sort((a, b) => a.timestamp - b.timestamp);
  if (merged.length > stored.length) {
    await saveStoredActivity(address, merged);
  }
  return merged;
}

async function fetchPositions(address: string): Promise<PositionRow[]> {
  const url = `${DATA_API_V2}/positions?user=${address}&limit=500`;
  return unwrapList(await fetchJson(url)).map((row) => ({
    title: str(row.title),
    outcome: str(row.outcome),
    size: num(row.current_size ?? row.size),
    initialValue: num(row.entry_cost_usdc ?? row.initialValue ?? row.initial_value),
    currentValue: num(row.current_value ?? row.currentValue),
    cashPnl: num(row.unrealized_pnl ?? row.cashPnl),
    percentPnl: num(row.percent_pnl ?? row.percentPnl),
    realizedPnl: num(row.realized_pnl ?? row.realizedPnl),
    curPrice: num(row.current_price ?? row.curPrice),
    redeemable: Boolean(row.redeemable),
  }));
}

function emptyTrader(address: string): TraderAnalysis {
  return {
    address,
    label: shortLabel(address),
    analysisDate: new Date().toISOString(),
    periodMonths: 0,
    trades: {
      total: 0,
      buys: 0,
      sells: 0,
      firstTrade: '',
      lastTrade: '',
      daysActive: 0,
    },
    volume: { totalBought: 0, totalSold: 0, netFlow: 0 },
    positions: {
      total: 0,
      open: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      initialValue: 0,
      currentValue: 0,
    },
    pnl: {
      unrealized: 0,
      realized: 0,
      total: 0,
      roi: 0,
      monthlyRoi: 0,
      annualizedRoi: 0,
    },
    redeemable: { count: 0, value: 0 },
    monthlyBreakdown: [],
    dailyBreakdown: [],
    topWinners: [],
    topLosers: [],
  };
}

function buildReportFromActivity(
  addr: string,
  activity: ActivityRow[],
  positions: PositionRow[]
): TraderAnalysis {
  let totalBought = 0;
  let totalSold = 0;
  let buyCount = 0;
  let sellCount = 0;
  const monthlyStats = new Map<string, MonthlyStats>();
  const dailyStats = new Map<string, DailyStats>();
  const positionTracker = new Map<string, { shares: number; totalCost: number }>();

  for (const trade of activity) {
    if (!trade.timestamp) continue;
    const month = formatMonth(trade.timestamp);
    const day = formatDate(trade.timestamp);

    if (!monthlyStats.has(month)) {
      monthlyStats.set(month, {
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
    if (!dailyStats.has(day)) {
      dailyStats.set(day, {
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

    const m = monthlyStats.get(month)!;
    const d = dailyStats.get(day)!;
    m.tradeCount++;
    d.tradeCount++;

    const shares = trade.price > 0 ? trade.usdcSize / trade.price : 0;
    if (trade.side === 'BUY') {
      totalBought += trade.usdcSize;
      buyCount++;
      m.totalBought += trade.usdcSize;
      m.buyCount++;
      d.totalBought += trade.usdcSize;
      d.buyCount++;
      const pos = positionTracker.get(trade.asset) || { shares: 0, totalCost: 0 };
      pos.shares += shares;
      pos.totalCost += trade.usdcSize;
      positionTracker.set(trade.asset, pos);
    } else {
      totalSold += trade.usdcSize;
      sellCount++;
      m.totalSold += trade.usdcSize;
      m.sellCount++;
      d.totalSold += trade.usdcSize;
      d.sellCount++;
      const pos = positionTracker.get(trade.asset);
      if (pos && pos.shares > 0) {
        const avg = pos.totalCost / pos.shares;
        const realized = trade.usdcSize - avg * shares;
        m.realizedPnl += realized;
        d.realizedPnl += realized;
        const ratio = Math.min(shares / pos.shares, 1);
        pos.shares -= shares;
        pos.totalCost -= pos.totalCost * ratio;
        if (pos.shares <= 0) positionTracker.delete(trade.asset);
        else positionTracker.set(trade.asset, pos);
      }
    }
    m.netFlow = m.totalSold - m.totalBought;
    d.netFlow = d.totalSold - d.totalBought;
  }

  let initialValue = 0;
  let currentValue = 0;
  let unrealized = 0;
  let realizedFromPos = 0;
  let redeemableCount = 0;
  let redeemableValue = 0;
  const withPnL: { title: string; outcome: string; pnl: number; roi: number }[] = [];

  for (const pos of positions) {
    initialValue += pos.initialValue || 0;
    currentValue += pos.currentValue || 0;
    unrealized += pos.cashPnl || 0;
    realizedFromPos += pos.realizedPnl || 0;
    const total = (pos.cashPnl || 0) + (pos.realizedPnl || 0);
    withPnL.push({
      title: pos.title || 'Unknown',
      outcome: pos.outcome || '',
      pnl: total,
      roi: pos.percentPnl || 0,
    });
    if (pos.redeemable && pos.curPrice >= 0.99) {
      redeemableCount++;
      redeemableValue += pos.currentValue || 0;
    }
  }

  withPnL.sort((a, b) => b.pnl - a.pnl);
  const winners = withPnL.filter((p) => p.pnl > 0).length;
  const losers = withPnL.filter((p) => p.pnl < 0).length;
  const open = positions.filter((p) => p.size > 0).length;
  const totalPnL = unrealized + realizedFromPos;
  const roi = initialValue > 0 ? (totalPnL / initialValue) * 100 : 0;

  const first = activity[0]?.timestamp;
  const last = activity[activity.length - 1]?.timestamp;
  const daysActive =
    first && last ? Math.max(1, Math.ceil((last - first) / 86400)) : activity.length > 0 ? 1 : 0;
  const periodMonths = daysActive > 0 ? daysActive / 30.44 : 0;

  return {
    address: addr,
    label: shortLabel(addr),
    analysisDate: new Date().toISOString(),
    periodMonths: Number(periodMonths.toFixed(1)),
    trades: {
      total: activity.length,
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
      total: positions.length,
      open,
      winners,
      losers,
      winRate: winners + losers > 0 ? (winners / (winners + losers)) * 100 : 0,
      initialValue,
      currentValue,
    },
    pnl: {
      unrealized,
      realized: realizedFromPos,
      total: totalPnL,
      roi,
      monthlyRoi: periodMonths > 0 ? roi / periodMonths : 0,
      annualizedRoi: periodMonths > 0 ? (roi / periodMonths) * 12 : 0,
    },
    redeemable: { count: redeemableCount, value: redeemableValue },
    monthlyBreakdown: Array.from(monthlyStats.values()).sort((a, b) =>
      a.month.localeCompare(b.month)
    ),
    dailyBreakdown: Array.from(dailyStats.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    ),
    topWinners: withPnL.filter((p) => p.pnl > 0).slice(0, 5),
    topLosers: withPnL.filter((p) => p.pnl < 0).slice(-5).reverse(),
  };
}

/** Prefer the report that still has the fuller trade history. */
function preferRicher(a: TraderAnalysis, b: TraderAnalysis | null): TraderAnalysis {
  if (!b) return a;
  if (a.trades.total >= b.trades.total) return a;
  // Keep older history from cache, but refresh live position/PnL fields from `a`
  return {
    ...b,
    analysisDate: a.analysisDate,
    positions: a.positions,
    pnl: a.pnl,
    redeemable: a.redeemable,
    topWinners: a.topWinners.length ? a.topWinners : b.topWinners,
    topLosers: a.topLosers.length ? a.topLosers : b.topLosers,
  };
}

export async function analyzeTraderLive(address: string): Promise<TraderAnalysis> {
  const addr = address.toLowerCase();
  const cached = await loadCachedStats(addr);
  try {
    const [activity, positions] = await Promise.all([
      fetchAndMergeActivity(addr),
      fetchPositions(addr),
    ]);

    const report = preferRicher(
      buildReportFromActivity(addr, activity, positions),
      cached
    );
    await saveCachedStats(report);
    return report;
  } catch (error) {
    console.warn(`Live trader stats failed for ${addr}:`, error);
    return cached || emptyTrader(addr);
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Live Polymarket Data API stats — activity is merged into Mongo and never truncated. */
export async function buildLiveTraderReports(
  addresses: string[]
): Promise<TraderAnalysis[]> {
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean)));
  return mapPool(unique, CONCURRENCY, analyzeTraderLive);
}
