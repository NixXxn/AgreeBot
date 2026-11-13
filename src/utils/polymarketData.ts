/**
 * Polymarket Data API v2 helpers.
 * v1 routes (/activity, /positions) return HTTP 410 as of Nov 2026.
 * v2 wraps payloads in `{ data, pagination }` and uses snake_case fields.
 */
import fetchData from './fetchData';

const DATA_API_V2 = 'https://data-api.polymarket.com/v2';

type Json = Record<string, unknown>;

const unwrapList = (payload: unknown): Json[] => {
    if (Array.isArray(payload)) return payload as Json[];
    if (payload && typeof payload === 'object' && Array.isArray((payload as Json).data)) {
        return (payload as Json).data as Json[];
    }
    return [];
};

const num = (v: unknown, fallback = 0): number => {
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isNaN(n) ? fallback : n;
    }
    return fallback;
};

const str = (v: unknown, fallback = ''): string =>
    v === null || v === undefined ? fallback : String(v);

/**
 * Normalize a v2 activity row to the camelCase shape the bot already uses.
 */
export const normalizeActivity = (row: Json) => {
    const tokenId = str(row.token_id ?? row.tokenId ?? row.asset);
    return {
        proxyWallet: str(row.proxy_wallet ?? row.proxyWallet),
        timestamp: num(row.timestamp ?? row.block_timestamp),
        conditionId: str(row.condition_id ?? row.conditionId),
        type: str(row.type, 'TRADE').toUpperCase(),
        size: num(row.size),
        usdcSize: num(row.usdc_size ?? row.usdcSize),
        transactionHash: str(row.transaction_hash ?? row.transactionHash),
        price: num(row.price),
        asset: tokenId,
        side: str(row.side, 'BUY').toUpperCase(),
        outcomeIndex: num(row.outcome_index ?? row.outcomeIndex),
        title: str(row.title),
        slug: str(row.slug),
        icon: str(row.icon),
        eventSlug: str(row.event_slug ?? row.eventSlug),
        outcome: str(row.outcome),
        name: str(row.name),
        pseudonym: str(row.pseudonym),
        bio: str(row.bio),
        profileImage: str(row.profile_image ?? row.profileImage),
        profileImageOptimized: str(
            row.profile_image_optimized ?? row.profileImageOptimized
        ),
    };
};

/**
 * Normalize a v2 position row to the camelCase shape used across the bot.
 */
export const normalizePosition = (row: Json) => {
    const tokenId = str(row.token_id ?? row.tokenId ?? row.asset);
    const size = num(row.current_size ?? row.currentSize ?? row.size ?? row.total_size);
    const currentValue = num(row.current_value ?? row.currentValue);
    const initialValue = num(
        row.entry_cost_usdc ?? row.total_cost_usdc ?? row.initialValue ?? row.initial_value
    );
    return {
        proxyWallet: str(row.proxy_wallet ?? row.proxyWallet),
        asset: tokenId,
        conditionId: str(row.condition_id ?? row.conditionId),
        size,
        avgPrice: num(row.avg_price ?? row.avgPrice),
        initialValue,
        currentValue,
        cashPnl: num(row.unrealized_pnl ?? row.cashPnl ?? row.unrealizedPnl),
        percentPnl: num(row.percent_pnl ?? row.percentPnl),
        totalBought: num(row.total_size ?? row.totalBought ?? size),
        realizedPnl: num(row.realized_pnl ?? row.realizedPnl),
        percentRealizedPnl: num(row.percent_realized_pnl ?? row.percentRealizedPnl),
        curPrice: num(row.current_price ?? row.curPrice ?? row.currentPrice),
        redeemable: Boolean(row.redeemable),
        mergeable: Boolean(row.mergeable),
        title: str(row.title),
        slug: str(row.slug),
        icon: str(row.icon),
        eventSlug: str(row.event_slug ?? row.eventSlug),
        outcome: str(row.outcome),
        outcomeIndex: num(row.outcome_index ?? row.outcomeIndex),
        oppositeOutcome: str(row.opposite_outcome ?? row.oppositeOutcome),
        oppositeAsset: str(row.opposite_token_id ?? row.oppositeAsset ?? row.oppositeTokenId),
        endDate: str(row.end_date ?? row.endDate),
        negativeRisk: Boolean(row.negative_risk ?? row.negativeRisk),
    };
};

export const fetchUserActivity = async (
    user: string,
    options: { type?: string; limit?: number } = {}
) => {
    const params = new URLSearchParams({
        user,
        limit: String(options.limit ?? 100),
    });
    if (options.type) params.set('type', options.type);

    const payload = await fetchData(`${DATA_API_V2}/activity?${params.toString()}`);
    return unwrapList(payload).map(normalizeActivity);
};

export const fetchUserPositions = async (user: string, options: { limit?: number } = {}) => {
    const params = new URLSearchParams({
        user,
        limit: String(options.limit ?? 500),
    });
    const payload = await fetchData(`${DATA_API_V2}/positions?${params.toString()}`);
    return unwrapList(payload).map(normalizePosition);
};
