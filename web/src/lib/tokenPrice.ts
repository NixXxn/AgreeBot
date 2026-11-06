export interface PriceInfo {
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

function parseJsonArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

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
    const prices = parseJsonArray(market.outcomePrices ?? market.outcome_prices).map((p) =>
      Number(p)
    );
    const closed = Boolean(market.closed || market.resolved || market.active === false);

    let idx = tokens.indexOf(tokenId);
    if (idx < 0 && outcome) {
      idx = outcomes.findIndex((o) => o.toLowerCase() === outcome.toLowerCase());
    }
    if (idx < 0 || !Number.isFinite(prices[idx])) {
      return closed ? { price: null, resolved: true } : null;
    }

    const price = prices[idx];
    const snapped = price >= 0.99 ? 1 : price <= 0.01 ? 0 : price;
    const resolved = closed || snapped === 0 || snapped === 1;
    return { price: snapped, resolved };
  } catch {
    return null;
  }
}

export async function resolveTokenPrice(
  tokenId: string,
  conditionId: string,
  outcome?: string
): Promise<PriceInfo> {
  const mid = await fetchClobMidpoint(tokenId);
  if (mid != null) {
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

export function computePnL(
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
    side.toUpperCase() === 'SELL' ? entryPrice - currentPrice : currentPrice - entryPrice;
  return {
    pnl: shares * priceDelta,
    roi: (priceDelta / entryPrice) * 100,
  };
}
