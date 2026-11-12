/**
 * Polymarket Data API v2 activity helpers.
 * Pagination is cursor-only — `offset` returns HTTP 400.
 */

const DATA_API_V2 = 'https://data-api.polymarket.com/v2';

type Json = Record<string, unknown>;

export type PolymarketActivityRow = {
  timestamp: number;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  conditionId: string;
  asset: string;
  type: string;
};

function unwrapList(payload: unknown): Json[] {
  if (Array.isArray(payload)) return payload as Json[];
  if (payload && typeof payload === 'object' && Array.isArray((payload as Json).data)) {
    return (payload as Json).data as Json[];
  }
  return [];
}

function nextCursor(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const pagination = (payload as Json).pagination;
  if (!pagination || typeof pagination !== 'object') return null;
  const p = pagination as Json;
  if (p.has_more === false) return null;
  const cursor = p.next_cursor ?? p.nextCursor;
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null;
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

function toUnixSeconds(raw: unknown): number {
  if (typeof raw === 'string' && raw.includes('T')) {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  const n = num(raw);
  if (!n) return 0;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
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
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * 2 ** attempt);
      await sleep(waitMs);
      continue;
    }
    throw lastError;
  }
  throw lastError || new Error(`Data API failed for ${url}`);
}

function parseRow(row: Json): PolymarketActivityRow | null {
  const type = str(row.type, 'TRADE').toUpperCase();
  if (type && type !== 'TRADE' && type !== 'ORDER_FILLED') return null;
  const side = str(row.side, 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  return {
    timestamp: toUnixSeconds(row.timestamp ?? row.block_timestamp),
    side,
    usdcSize: num(row.usdc_size ?? row.usdcSize),
    price: num(row.price),
    title: str(row.title),
    outcome: str(row.outcome),
    conditionId: str(row.condition_id ?? row.conditionId),
    asset: str(row.token_id ?? row.tokenId ?? row.asset),
    type,
  };
}

/**
 * Fetch activity pages via `cursor` / `next_cursor` until exhausted or maxPages.
 */
export async function fetchActivityCursor(
  user: string,
  options?: { limit?: number; maxPages?: number }
): Promise<PolymarketActivityRow[]> {
  const limit = options?.limit ?? 100;
  const maxPages = options?.maxPages ?? 50;
  const rows: PolymarketActivityRow[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      user,
      limit: String(limit),
    });
    if (cursor) params.set('cursor', cursor);

    const payload = await fetchJson(`${DATA_API_V2}/activity?${params.toString()}`);
    const chunk = unwrapList(payload);
    if (chunk.length === 0) break;

    for (const raw of chunk) {
      const row = parseRow(raw);
      if (row && row.timestamp) rows.push(row);
    }

    cursor = nextCursor(payload);
    if (!cursor) break;
  }

  return rows.sort((a, b) => a.timestamp - b.timestamp);
}
