import * as dotenv from 'dotenv';

dotenv.config();

const stripQuotes = (value: string): string => {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
};

const truthy = (value: string | undefined, fallback = false): boolean => {
    if (value === undefined || value === '') return fallback;
    return ['true', '1', 'yes', 'on'].includes(stripQuotes(value).toLowerCase());
};

const num = (value: string | undefined, fallback: number): number => {
    const n = parseFloat(stripQuotes(value || ''));
    return Number.isFinite(n) ? n : fallback;
};

const int = (value: string | undefined, fallback: number): number => {
    const n = parseInt(stripQuotes(value || ''), 10);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * Pipeline-only env — does NOT import bot `ENV` (avoids wallet validation + bot coupling).
 */
export const PIPELINE = {
    MONGO_URI: stripQuotes(process.env.MONGO_URI || ''),
    GRAVIA_API: stripQuotes(process.env.GRAVIA_API || process.env.GRAVIA_API_KEY || ''),
    GRAVIA_SIGNING_SECRET: stripQuotes(process.env.GRAVIA_SIGNING_SECRET || ''),
    GRAVIA_SUBSCRIPTION_ID: stripQuotes(process.env.GRAVIA_SUBSCRIPTION_ID || ''),
    GRAVIA_PUBLIC_BASE_URL: stripQuotes(
        process.env.GRAVIA_PUBLIC_BASE_URL || 'https://btc.webwien.at'
    ).replace(/\/$/, ''),
    GRAVIA_WEBHOOK_PATH: stripQuotes(process.env.GRAVIA_WEBHOOK_PATH || '/api/webhooks/gravia'),
    GRAVIA_FEED_ENABLED: truthy(process.env.GRAVIA_FEED_ENABLED, true),

    /** Master switch for this worker. */
    ENABLED: truthy(process.env.TRADER_PIPELINE_ENABLED, true),

    /** Write top wallets into runtime_settings.USER_ADDRESSES for the copy bot. */
    AUTO_APPLY: truthy(process.env.TRADER_PIPELINE_AUTO_APPLY, true),

    /** POST after applying traders so the bot reloads without waiting for the 30s poll. */
    BOT_RELOAD_URL: stripQuotes(
        process.env.BOT_RELOAD_URL || 'http://127.0.0.1:3001/runtime/reload'
    ),

    HEALTH_PORT: int(process.env.PIPELINE_HEALTH_PORT || process.env.HEALTH_PORT, 3002),

    /** Leave headroom under Gravia's default 100 req/min. */
    RATE_LIMIT_PER_MIN: int(process.env.GRAVIA_RATE_LIMIT_PER_MIN, 60),
    RATE_LIMIT_MIN_REMAINING: int(process.env.GRAVIA_RATE_LIMIT_MIN_REMAINING, 8),

    LIST_SIZE: int(process.env.TRADER_PIPELINE_LIST_SIZE, 50),
    MIN_ROI: num(process.env.TRADER_PIPELINE_MIN_ROI, 0.1),
    MIN_WIN_RATE: num(process.env.TRADER_PIPELINE_MIN_WIN_RATE, 0.55),
    MIN_VOLUME_USD: num(process.env.TRADER_PIPELINE_MIN_VOLUME_USD, 100),
    /** Average trades/day over the activity lookback window. */
    MIN_TRADES_PER_DAY: num(process.env.TRADER_PIPELINE_MIN_TRADES_PER_DAY, 10),
    /** Distinct calendar days with ≥1 crypto-5m trade in the last 7 days. */
    MIN_ACTIVE_DAYS_PER_WEEK: int(process.env.TRADER_PIPELINE_MIN_ACTIVE_DAYS, 4),
    ACTIVITY_LOOKBACK_DAYS: int(process.env.TRADER_PIPELINE_ACTIVITY_DAYS, 7),

    /** How often to re-score candidates + curated list. */
    EVAL_INTERVAL_MS: int(process.env.TRADER_PIPELINE_EVAL_INTERVAL_MS, 15 * 60 * 1000),
    /** Refresh current 5m market condition IDs for the WS filter. */
    MARKET_REFRESH_MS: int(process.env.TRADER_PIPELINE_MARKET_REFRESH_MS, 90_000),
    /** Max wallets to REST-evaluate per cycle (rate-limit budget). */
    MAX_EVAL_PER_CYCLE: int(process.env.TRADER_PIPELINE_MAX_EVAL_PER_CYCLE, 60),
    /** Re-evaluate a wallet at most this often unless forced. */
    EVAL_CACHE_MS: int(process.env.TRADER_PIPELINE_EVAL_CACHE_MS, 6 * 60 * 60 * 1000),

    CRYPTOS: (
        process.env.TRADER_PIPELINE_CRYPTOS || 'BTC,ETH,SOL,XRP,BNB,DOGE,HYPE,ZEC'
    )
        .split(',')
        .map((s) => stripQuotes(s).toUpperCase())
        .filter(Boolean),

    INTERVAL: '5m' as const,
    GRAVIA_BASE: 'https://data.gravia.trade',
};

export function assertPipelineConfig(): void {
    if (!PIPELINE.MONGO_URI) {
        throw new Error('TRADER_PIPELINE requires MONGO_URI');
    }
    if (!PIPELINE.GRAVIA_API) {
        throw new Error('TRADER_PIPELINE requires GRAVIA_API (or GRAVIA_API_KEY)');
    }
}
