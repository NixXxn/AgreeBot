import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import type { BotTradeRow } from '@/types/trades';

interface PriceInfo {
  price: number | null;
  resolved: boolean;
}

async function fetchClobMidpoint(tokenId: string): Promise<number | null> {
  try {
    const url = `https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const mid = Number(data?.mid ?? data?.price ?? NaN);
    return Number.isFinite(mid) && mid >= 0 ? mid : null;
  } catch {
    return null;
  }
}

async function fetchClobLastPrice(tokenId: string): Promise<number | null> {
  try {
    const url = `https://clob.polymarket.com/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const price = Number(data?.price ?? data?.last_trade_price ?? NaN);
    return Number.isFinite(price) && price >= 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Gamma market resolution — for closed short-window markets midpoint is often gone.
 * Returns price of our specific token (0 or 1 when resolved).
 */
async function fetchGammaTokenPrice(
  conditionId: string,
  tokenId: string,
  outcome?: string
): Promise<PriceInfo | null> {
  if (!conditionId && !tokenId) return null;
  try {
    const params = new URLSearchParams();
    if (conditionId) params.set('condition_ids', conditionId);
    const url = `https://gamma-api.polymarket.com/markets?${params.toString()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const markets = await res.json();
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const market =
      markets.find((m: Record<string, unknown>) => {
        const tokens = parseJsonArray(m.clobTokenIds ?? m.clob_token_ids);
        return tokens.includes(tokenId);
      }) || markets[0];

    const tokens = parseJsonArray(market.clobTokenIds ?? market.clob_token_ids);
    const outcomes = parseJsonArray(market.outcomes);
    const prices = parseJsonArray(market.outcomePrices ?? market.outcome_prices).map(
      (p) => Number(p)
    );
    const closed = Boolean(market.closed || market.resolved || market.active === false);

    let idx = tokens.indexOf(tokenId);
    if (idx < 0 && outcome) {
      idx = outcomes.findIndex(
        (o) => o.toLowerCase() === outcome.toLowerCase()
      );
    }
    if (idx < 0 || !Number.isFinite(prices[idx])) {
      return closed ? { price: null, resolved: true } : null;
    }

    const price = prices[idx];
    // Treat near-0/1 as resolved even if closed flag lags
    const snapped =
      price >= 0.99 ? 1 : price <= 0.01 ? 0 : price;
    const resolved = closed || snapped === 0 || snapped === 1;
    return { price: snapped, resolved };
  } catch {
    return null;
  }
}

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return [];
}

async function resolveTokenPrice(
  tokenId: string,
  conditionId: string,
  outcome?: string
): Promise<PriceInfo> {
  const mid = await fetchClobMidpoint(tokenId);
  if (mid != null) {
    // Live mid near extremes often means resolved/settling
    if (mid >= 0.99) return { price: 1, resolved: true };
    if (mid <= 0.01) return { price: 0, resolved: true };
    return { price: mid, resolved: false };
  }

  const last = await fetchClobLastPrice(tokenId);
  if (last != null) {
    if (last >= 0.99) return { price: 1, resolved: true };
    if (last <= 0.01) return { price: 0, resolved: true };
  }

  const gamma = await fetchGammaTokenPrice(conditionId, tokenId, outcome);
  if (gamma) return gamma;

  if (last != null) return { price: last, resolved: false };
  return { price: null, resolved: false };
}

function computePnL(
  side: string,
  entryPrice: number,
  currentPrice: number | null,
  sizeUsd: number,
  entered: boolean
): { pnl: number | null; roi: number | null } {
  if (!entered || currentPrice == null || entryPrice <= 0 || sizeUsd <= 0) {
    return { pnl: null, roi: null };
  }
  const shares = sizeUsd / entryPrice;
  const priceDelta =
    side.toUpperCase() === 'SELL'
      ? entryPrice - currentPrice
      : currentPrice - entryPrice;
  const pnl = shares * priceDelta;
  const roi = (priceDelta / entryPrice) * 100;
  return { pnl, roi };
}

export async function GET() {
  try {
    const db = await getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'MONGO_URI not configured', trades: [] },
        { status: 200 }
      );
    }

    const docs = await db
      .collection('bot_signals')
      .find({})
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();

    const enteredDocs = docs.filter((d) => d.entered && d.asset);
    // Dedupe by asset for price fetches
    const uniqueAssets = Array.from(
      new Map(
        enteredDocs.map((d) => [
          String(d.asset),
          {
            asset: String(d.asset),
            conditionId: String(d.conditionId || ''),
            outcome: String(d.outcome || ''),
          },
        ])
      ).values()
    ).slice(0, 50);

    const priceMap = new Map<string, PriceInfo>();
    await Promise.all(
      uniqueAssets.map(async ({ asset, conditionId, outcome }) => {
        priceMap.set(asset, await resolveTokenPrice(asset, conditionId, outcome));
      })
    );

    const trades: BotTradeRow[] = docs.map((d) => {
      const side = (String(d.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as
        | 'BUY'
        | 'SELL';
      const entryPrice = Number(d.entryPrice || 0);
      const sizeUsd = Number(d.sizeUsd || 0);
      const entered = Boolean(d.entered);
      const info = entered ? priceMap.get(String(d.asset)) : undefined;
      const currentPrice = info?.price ?? null;
      const resolved = Boolean(info?.resolved);
      const { pnl, roi } = computePnL(side, entryPrice, currentPrice, sizeUsd, entered);

      return {
        id: String(d._id),
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
        agreementCount: Number(d.agreementCount || 0),
        agreeingTraders: Array.isArray(d.agreeingTraders)
          ? d.agreeingTraders.map(String)
          : [],
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
    const totalPnl = entered.reduce((s, t) => s + (t.pnl ?? 0), 0);

    return NextResponse.json({
      trades,
      summary: {
        total: trades.length,
        entered: entered.length,
        skipped: trades.length - entered.length,
        totalPnl,
        paper: trades.some((t) => t.paper),
        resolved: entered.filter((t) => t.resolved).length,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch trades',
        trades: [],
      },
      { status: 500 }
    );
  }
}
