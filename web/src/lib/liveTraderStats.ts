import type { DailyStats, MonthlyStats, TraderAnalysis } from '@/types/trader';
import { getDb } from './mongo';
import { fetchActivityCursor } from './polymarketActivity';

const DATA_API_V2 = 'https://data-api.polymarket.com/v2';
/** Hard ceiling per wallet so a bad API can't loop forever. */
const MAX_ACTIVITY_PAGES = 100;
/** Keep Data API under rate limits with large trader lists. */
const CONCURRENCY = 2;
const CACHE_TTL_MS = 30 * 60 * 1000;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url: string, retries = 4): Promise<unknown> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
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
    if (response.ok) return payload;

    const errMsg =
      payload && typeof payload === 'object' && 'error' in (payload as object)
        ? String((payload as { error: unknown }).error)
        : `HTTP ${response.status}`;
    lastError = new Error(`Data API ${response.status} for ${url}: ${errMsg}`);

    if (response.status === 429 || response.status === 503) {
      const retryAfter = Number(response.headers.get('retry-after') || '');
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(8000, 750 * 2 ** attempt);
      await sleep(waitMs);
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error(`Data API failed for ${url}`);
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
  const map = await loadCachedStatsMany([address]);
  return map.get(address.toLowerCase()) || null;
}

async function loadCachedStatsMany(
  addresses: string[]
): Promise<Map<string, TraderAnalysis>> {
  const out = new Map<string, TraderAnalysis>();
  if (addresses.length === 0) return out;
  try {
    const db = await getDb();
    if (!db) return out;
    const ids = addresses.map((a) => a.toLowerCase());
    const docs = await db
      .collection(STATS_COLLECTION)
      .find({ _id: { $in: ids } } as never)
      .toArray();
    for (const doc of docs) {
      const report = (doc as unknown as { report?: TraderAnalysis }).report;
      const id = String((doc as { _id?: unknown })._id || '').toLowerCase();
      if (report && id) out.set(id, report);
    }
  } catch (error) {
    console.warn('Failed to load trader stats cache batch:', error);
  }
  return out;
}

function cacheAgeMs(report: TraderAnalysis | null | undefined): number {
  if (!report?.analysisDate) return Number.POSITIVE_INFINITY;
  const t = Date.parse(report.analysisDate);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Date.now() - t;
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
 * Pull Data API activity (cursor pages), merge with Mongo history, never drop old rows.
 * `light` only pulls a couple pages (rate-limit friendly for large trader lists).
 */
async function fetchAndMergeActivity(
  address: string,
  options?: { light?: boolean }
): Promise<ActivityRow[]> {
  const stored = await loadStoredActivity(address);
  const byKey = new Map<string, ActivityRow>();
  for (const row of stored) byKey.set(activityKey(row), row);

  const light = Boolean(options?.light);
  const maxPages = light
    ? stored.length > 0
      ? 1
      : 3
    : stored.length > 0
      ? Math.min(5, MAX_ACTIVITY_PAGES)
      : Math.min(20, MAX_ACTIVITY_PAGES);

  const fresh = await fetchActivityCursor(address, { limit: 100, maxPages });

  let newCount = 0;
  for (const row of fresh) {
    const mapped: ActivityRow = {
      timestamp: row.timestamp,
      side: row.side,
      usdcSize: row.usdcSize,
      price: row.price,
      asset: row.asset,
      title: row.title,
      outcome: row.outcome,
    };
    const key = activityKey(mapped);
    if (!byKey.has(key)) {
      byKey.set(key, mapped);
      newCount++;
    }
  }

  const merged = Array.from(byKey.values()).sort((a, b) => a.timestamp - b.timestamp);
  if (newCount > 0 || merged.length > stored.length) {
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

export async function analyzeTraderLive(
  address: string,
  options?: { light?: boolean; cached?: TraderAnalysis | null }
): Promise<TraderAnalysis> {
  const addr = address.toLowerCase();
  const cached = options?.cached !== undefined ? options.cached : await loadCachedStats(addr);
  try {
    const [activity, positions] = await Promise.all([
      fetchAndMergeActivity(addr, { light: options?.light }),
      fetchPositions(addr),
    ]);

    const report = preferRicher(
      buildReportFromActivity(addr, activity, positions),
      cached
    );
    await saveCachedStats(report);
    return report;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Don't spam logs for expected rate limits — cache covers the UI
    if (!/Data API 429/.test(msg)) {
      console.warn(`Live trader stats failed for ${addr}:`, error);
    }
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
      // Small gap between wallets to stay under Data API burst limits
      await sleep(150);
    }
  });
  await Promise.all(workers);
  return out;
}

export type LiveTraderReportsResult = {
  traders: TraderAnalysis[];
  source: 'cache' | 'live-data-api' | 'cache+partial-refresh';
  refreshed: number;
  cached: number;
  message?: string;
};

/**
 * Prefer Mongo cache for fast dashboard loads. Only hit Data API for missing/stale
 * wallets (or all on forceRefresh), with low concurrency + 429 retries.
 */
export async function buildLiveTraderReports(
  addresses: string[],
  options?: { forceRefresh?: boolean }
): Promise<LiveTraderReportsResult> {
  const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean)));
  const cachedMap = await loadCachedStatsMany(unique);
  const forceRefresh = Boolean(options?.forceRefresh);

  const needsRefresh = unique.filter((addr) => {
    const cached = cachedMap.get(addr);
    if (!cached) return true;
    if (forceRefresh) return true;
    return cacheAgeMs(cached) > CACHE_TTL_MS;
  });

  // Fast path: serve cache when most wallets are fresh
  if (!forceRefresh && needsRefresh.length === 0 && cachedMap.size > 0) {
    return {
      traders: unique.map((a) => cachedMap.get(a) || emptyTrader(a)),
      source: 'cache',
      refreshed: 0,
      cached: cachedMap.size,
      message: `Cached trader stats (${cachedMap.size} wallets, TTL ${CACHE_TTL_MS / 60000}m)`,
    };
  }

  // On normal page load with a large list, only top up a small batch of missing/stale
  // so the dashboard returns quickly; full refresh is via ?refresh=true
  const refreshBatch = forceRefresh
    ? needsRefresh
    : needsRefresh.slice(0, Math.min(12, needsRefresh.length));

  if (refreshBatch.length > 0) {
    const fresh = await mapPool(refreshBatch, CONCURRENCY, (addr) =>
      analyzeTraderLive(addr, {
        light: !forceRefresh || unique.length > 40,
        cached: cachedMap.get(addr) || null,
      })
    );
    for (const report of fresh) {
      cachedMap.set(report.address.toLowerCase(), report);
    }
  }

  const traders = unique.map((a) => cachedMap.get(a) || emptyTrader(a));
  const stillMissing = unique.filter((a) => !cachedMap.has(a)).length;

  return {
    traders,
    source: forceRefresh
      ? 'live-data-api'
      : refreshBatch.length > 0
        ? 'cache+partial-refresh'
        : 'cache',
    refreshed: refreshBatch.length,
    cached: unique.length - stillMissing,
    message: forceRefresh
      ? `Refreshed ${refreshBatch.length} wallet(s) from Polymarket Data API`
      : stillMissing > 0 || needsRefresh.length > refreshBatch.length
        ? `Loaded cache; refreshed ${refreshBatch.length} stale/missing (use Refresh for full update; ${needsRefresh.length} needed)`
        : `Cached trader stats (${cachedMap.size} wallets)`,
  };
}
