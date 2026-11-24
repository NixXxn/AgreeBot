import { PIPELINE } from './config';
import { GraviaRateLimiter } from './rateLimiter';

export const rateLimiter = new GraviaRateLimiter(
    PIPELINE.RATE_LIMIT_PER_MIN,
    PIPELINE.RATE_LIMIT_MIN_REMAINING
);

export type CurrentMarket = {
    condition_id: string;
    slug: string;
    crypto: string;
    interval: string;
    token_ids: string[];
    start_time?: number;
    end_time?: number;
};

type CategoryMetric = {
    slug: string;
    label: string;
    unique_markets: number;
    win_rate: number | null;
    pnl: { total: number; positive: number; negative: number };
    volume: {
        total: number;
        buy: number;
        sell: number;
        redemption: number;
        split: number;
        merge: number;
    };
    positions: { total: number; open: number; closed: number };
    children: CategoryMetric[];
};

export type UserCategoryMetrics = {
    user_address: string;
    window: string;
    as_of: string;
    categories: CategoryMetric[];
};

export type UserActivity = {
    type?: string;
    timestamp?: string;
    side?: string;
    outcome?: string;
    token_id?: string;
    condition_id?: string;
    slug?: string;
    market?: { condition_id?: string; slug?: string; outcomes?: string[] };
    amount_usd?: number | string;
    price?: number | string;
};

async function graviaFetch<T>(
    path: string,
    init: RequestInit = {},
    attempt = 0
): Promise<T> {
    await rateLimiter.acquire();

    const res = await fetch(`${PIPELINE.GRAVIA_BASE}${path}`, {
        ...init,
        headers: {
            Authorization: PIPELINE.GRAVIA_API,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...(init.headers || {}),
        },
    });

    rateLimiter.observeHeaders(res.headers);

    if (res.status === 429 && attempt < 5) {
        rateLimiter.observeRetryAfter(res.headers);
        await res.arrayBuffer().catch(() => undefined);
        return graviaFetch<T>(path, init, attempt + 1);
    }

    if (res.status === 503 && attempt < 4) {
        await res.arrayBuffer().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return graviaFetch<T>(path, init, attempt + 1);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        const err = new Error(`Gravia ${res.status} ${path}: ${body.slice(0, 240)}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
    }

    return (await res.json()) as T;
}

export async function getCurrentCryptoMarket(
    crypto: string,
    interval = PIPELINE.INTERVAL
): Promise<CurrentMarket | null> {
    const q = new URLSearchParams({ crypto, interval });
    const body = await graviaFetch<{
        current_market?: CurrentMarket;
        data?: { current_market?: CurrentMarket };
    }>(`/api/v1/markets/crypto/current?${q}`);

    const market = body.current_market ?? body.data?.current_market;
    if (!market?.condition_id) return null;
    return {
        condition_id: market.condition_id.toLowerCase(),
        slug: market.slug,
        crypto: market.crypto || crypto,
        interval: market.interval || interval,
        token_ids: (market.token_ids || []).map(String),
        start_time: market.start_time,
        end_time: market.end_time,
    };
}

export async function getUserCategoryMetrics(
    user: string,
    window: 'live' | '1d' | '7d' | '30d' | '60d' = '30d'
): Promise<UserCategoryMetrics> {
    const q = new URLSearchParams({ user, window });
    return graviaFetch<UserCategoryMetrics>(`/api/v1/users/categories?${q}`);
}

export async function getUserActivities(
    user: string,
    opts: {
        from?: string;
        to?: string;
        types?: string;
        limit?: number;
        cursor?: string;
        market_id?: string;
    } = {}
): Promise<{ activities: UserActivity[]; page?: { next_cursor?: string; has_more?: boolean } }> {
    const q = new URLSearchParams({ user });
    if (opts.from) q.set('from', opts.from);
    if (opts.to) q.set('to', opts.to);
    if (opts.types) q.set('types', opts.types);
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    if (opts.market_id) q.set('market_id', opts.market_id);

    const body = await graviaFetch<{
        activities?: UserActivity[];
        data?: UserActivity[] | { activities?: UserActivity[] };
        page?: { next_cursor?: string; has_more?: boolean };
    }>(`/api/v1/users/activities?${q}`);

    const activities =
        body.activities ||
        (Array.isArray(body.data)
            ? body.data
            : body.data && typeof body.data === 'object' && 'activities' in body.data
              ? (body.data as { activities?: UserActivity[] }).activities
              : []) ||
        [];

    return { activities, page: body.page };
}

/** Paginate activities with a hard page cap to protect the rate budget. */
export async function collectUserActivities(
    user: string,
    opts: { from: string; types?: string; maxPages?: number }
): Promise<UserActivity[]> {
    const maxPages = opts.maxPages ?? 8;
    const out: UserActivity[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
        const res = await getUserActivities(user, {
            from: opts.from,
            types: opts.types || 'trade',
            limit: 100,
            cursor,
        });
        out.push(...res.activities);
        if (!res.page?.has_more || !res.page.next_cursor) break;
        cursor = res.page.next_cursor;
    }
    return out;
}

export async function syncGraviaWalletFilter(wallets: string[]): Promise<{
    ok: boolean;
    message: string;
}> {
    if (!PIPELINE.GRAVIA_FEED_ENABLED) {
        return { ok: true, message: 'Gravia feed disabled — skip subscription sync' };
    }
    if (!PIPELINE.GRAVIA_SUBSCRIPTION_ID) {
        return { ok: false, message: 'GRAVIA_SUBSCRIPTION_ID missing — skip sync' };
    }

    const wallet_addresses = wallets
        .map((w) => w.toLowerCase())
        .filter((w) => /^0x[a-f0-9]{40}$/.test(w))
        .slice(0, 500);

    const path = PIPELINE.GRAVIA_WEBHOOK_PATH.startsWith('/')
        ? PIPELINE.GRAVIA_WEBHOOK_PATH
        : `/${PIPELINE.GRAVIA_WEBHOOK_PATH}`;
    const url = `${PIPELINE.GRAVIA_PUBLIC_BASE_URL}${path}`;

    const payload: Record<string, unknown> = {
        url,
        status: 'active',
        description: 'AgreeBot curated crypto-5m traders',
        filters: { wallet_addresses },
    };
    if (PIPELINE.GRAVIA_SIGNING_SECRET) {
        payload.secret = PIPELINE.GRAVIA_SIGNING_SECRET;
    }

    try {
        await graviaFetch(`/v1/webhooks/${PIPELINE.GRAVIA_SUBSCRIPTION_ID}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        return {
            ok: true,
            message: `Gravia subscription synced (${wallet_addresses.length} wallets)`,
        };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export function flattenCategories(categories: CategoryMetric[]): CategoryMetric[] {
    const out: CategoryMetric[] = [];
    const walk = (nodes: CategoryMetric[]) => {
        for (const n of nodes) {
            out.push(n);
            if (n.children?.length) walk(n.children);
        }
    };
    walk(categories);
    return out;
}

export function pickCryptoCategory(categories: CategoryMetric[]): CategoryMetric | null {
    const flat = flattenCategories(categories);
    const prefer =
        flat.find((c) => /5m|up.?down|short.?term/i.test(c.slug)) ||
        flat.find((c) => c.slug === 'crypto.prices') ||
        flat.find((c) => c.slug === 'crypto' || c.slug.startsWith('crypto.'));
    return prefer || null;
}
