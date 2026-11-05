import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import type { BotTradeRow } from '@/types/trades';

async function fetchMidpoint(tokenId: string): Promise<number | null> {
  if (!tokenId) return null;
  try {
    const url = `https://clob.polymarket.com/midpoint?token_id=${encodeURIComponent(tokenId)}`;
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) return null;
    const data = await res.json();
    const mid = Number(data?.mid ?? data?.price ?? NaN);
    return Number.isFinite(mid) ? mid : null;
  } catch {
    return null;
  }
}

function computePnL(
  side: string,
  entryPrice: number,
  currentPrice: number | null,
  sizeUsd: number,
  entered: boolean
): { pnl: number | null; roi: number | null } {
  if (!entered || !currentPrice || entryPrice <= 0 || sizeUsd <= 0) {
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

    // Fetch midpoints for unique assets (entered trades only, capped)
    const assetsNeedingPrice = Array.from(
      new Set(
        docs
          .filter((d) => d.entered && d.asset)
          .map((d) => String(d.asset))
      )
    ).slice(0, 40);

    const priceMap = new Map<string, number | null>();
    await Promise.all(
      assetsNeedingPrice.map(async (asset) => {
        priceMap.set(asset, await fetchMidpoint(asset));
      })
    );

    const trades: BotTradeRow[] = docs.map((d) => {
      const side = (String(d.side || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as
        | 'BUY'
        | 'SELL';
      const entryPrice = Number(d.entryPrice || 0);
      const sizeUsd = Number(d.sizeUsd || 0);
      const entered = Boolean(d.entered);
      const currentPrice = entered ? priceMap.get(String(d.asset)) ?? null : null;
      const { pnl, roi } = computePnL(side, entryPrice, currentPrice ?? null, sizeUsd, entered);

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
