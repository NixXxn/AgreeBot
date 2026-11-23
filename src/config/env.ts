import * as dotenv from 'dotenv';
import { CopyStrategy, CopyStrategyConfig, parseTieredMultipliers } from './copyStrategy';
dotenv.config();

/**
 * Strip wrapping quotes Coolify / copy-paste often leave on env values.
 * e.g. PROXY_WALLET=''  →  empty  |  PROXY_WALLET='0xabc…'  →  0xabc…
 */
const stripWrappingQuotes = (value: string): string => {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
};

const PLACEHOLDER_VALUES = new Set([
    '',
    'your_private_key_here_without_0x_prefix',
    'your_polygon_wallet',
    'changeme',
    'change_me',
    'todo',
    'xxx',
]);

/**
 * Normalize all string env vars once at startup so validation sees real values.
 */
const normalizeEnvValues = (): void => {
    for (const [key, raw] of Object.entries(process.env)) {
        if (typeof raw !== 'string') continue;
        const cleaned = stripWrappingQuotes(raw);
        if (cleaned !== raw) {
            process.env[key] = cleaned;
        }
        // Treat known placeholders as unset so required-env checks catch them
        if (PLACEHOLDER_VALUES.has(cleaned.toLowerCase()) || PLACEHOLDER_VALUES.has(cleaned)) {
            if (['PROXY_WALLET', 'PRIVATE_KEY', 'MONGO_URI', 'RPC_URL'].includes(key)) {
                delete process.env[key];
            }
        }
    }
};

normalizeEnvValues();

/**
 * Polymarket deposit-wallet aliases (signature type 3 / POLY_1271).
 * POLY_PRIVATE_KEY → PRIVATE_KEY, POLY_FUNDER → PROXY_WALLET when legacy keys empty.
 */
const applyPolymarketAliases = (): void => {
    const polyKey = process.env.POLY_PRIVATE_KEY?.trim();
    const polyFunder = process.env.POLY_FUNDER?.trim();
    if ((!process.env.PRIVATE_KEY || !process.env.PRIVATE_KEY.trim()) && polyKey) {
        process.env.PRIVATE_KEY = polyKey;
    }
    if ((!process.env.PROXY_WALLET || !process.env.PROXY_WALLET.trim()) && polyFunder) {
        process.env.PROXY_WALLET = polyFunder;
    }
};
applyPolymarketAliases();

/** Paper / preview mode: monitor & simulate only — no wallet or live orders required */
const isTruthyEnv = (value: string | undefined): boolean =>
    ['true', '1', 'yes', 'on'].includes((value || '').toLowerCase());

const PAPER_MODE_ENABLED =
    isTruthyEnv(process.env.PAPER_MODE) || isTruthyEnv(process.env.PREVIEW_MODE);

// Sensible defaults so paper mode can start with only MONGO_URI (traders live in Mongo/dashboard)
if (!process.env.CLOB_HTTP_URL) {
    process.env.CLOB_HTTP_URL = 'https://clob.polymarket.com/';
}
if (!process.env.CLOB_WS_URL) {
    process.env.CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws';
}
if (!process.env.USDC_CONTRACT_ADDRESS) {
    process.env.USDC_CONTRACT_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
}
if (!process.env.RPC_URL) {
    // Prefer 1rpc — publicnode often 403s eth_getTransactionReceipt (archive token)
    process.env.RPC_URL = 'https://1rpc.io/matic';
}

/**
 * Validate Ethereum address format
 */
const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

/**
 * Validate required environment variables
 */
const validateRequiredEnv = (): void => {
    // Traders are managed in the dashboard (Mongo). Paper mode only needs MongoDB.
    const required = PAPER_MODE_ENABLED
        ? ['MONGO_URI']
        : [
              'PROXY_WALLET',
              'PRIVATE_KEY',
              'CLOB_HTTP_URL',
              'CLOB_WS_URL',
              'MONGO_URI',
              'RPC_URL',
              'USDC_CONTRACT_ADDRESS',
          ];

    const missing: string[] = [];
    for (const key of required) {
        const value = process.env[key];
        if (!value || !value.trim()) {
            missing.push(key);
        }
    }

    if (missing.length > 0) {
        const paperHint = PAPER_MODE_ENABLED
            ? `Paper mode is ON — only MONGO_URI is required (add traders in the dashboard).\n`
            : `For paper/preview without a wallet, set PAPER_MODE=true (or PREVIEW_MODE=true).\n` +
              `Otherwise set PROXY_WALLET + PRIVATE_KEY for live trading.\n` +
              `Traders are managed in the dashboard Settings, not .env.\n`;
        throw new Error(
            `Missing required environment variables: ${missing.join(', ')}\n` +
                paperHint +
                `See .env.example and docs/COOLIFY.md.`
        );
    }
};

/**
 * Validate Ethereum addresses
 */
const validateAddresses = (): void => {
    const proxyWallet = process.env.PROXY_WALLET?.trim();
    if (proxyWallet && !isValidEthereumAddress(proxyWallet)) {
        throw new Error(
            `Invalid PROXY_WALLET address format: "${proxyWallet}"\n` +
                `Expected format: 0x followed by 40 hexadecimal characters\n` +
                `Tip: In Coolify, set the value without quotes (0xabc… not '0xabc…').`
        );
    }

    const usdc = process.env.USDC_CONTRACT_ADDRESS?.trim();
    if (usdc && !isValidEthereumAddress(usdc)) {
        throw new Error(
            `Invalid USDC_CONTRACT_ADDRESS format: "${usdc}"\n` +
                `Expected format: 0x followed by 40 hexadecimal characters`
        );
    }
};

/**
 * Validate numeric configuration values
 */
const validateNumericConfig = (): void => {
    const fetchInterval = parseInt(process.env.FETCH_INTERVAL || '1', 10);
    if (isNaN(fetchInterval) || fetchInterval <= 0) {
        throw new Error(
            `Invalid FETCH_INTERVAL: ${process.env.FETCH_INTERVAL}. Must be a positive integer.`
        );
    }

    const retryLimit = parseInt(process.env.RETRY_LIMIT || '3', 10);
    if (isNaN(retryLimit) || retryLimit < 1 || retryLimit > 10) {
        throw new Error(
            `Invalid RETRY_LIMIT: ${process.env.RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }

    const tooOldTimestamp = parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10);
    if (isNaN(tooOldTimestamp) || tooOldTimestamp < 1) {
        throw new Error(
            `Invalid TOO_OLD_TIMESTAMP: ${process.env.TOO_OLD_TIMESTAMP}. Must be a positive integer (hours).`
        );
    }

    const requestTimeout = parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10);
    if (isNaN(requestTimeout) || requestTimeout < 1000) {
        throw new Error(
            `Invalid REQUEST_TIMEOUT_MS: ${process.env.REQUEST_TIMEOUT_MS}. Must be at least 1000ms.`
        );
    }

    const networkRetryLimit = parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10);
    if (isNaN(networkRetryLimit) || networkRetryLimit < 1 || networkRetryLimit > 10) {
        throw new Error(
            `Invalid NETWORK_RETRY_LIMIT: ${process.env.NETWORK_RETRY_LIMIT}. Must be between 1 and 10.`
        );
    }

    if (process.env.CONSENSUS_ENABLED === 'true') {
        const minAgreement = parseInt(process.env.CONSENSUS_MIN_AGREEMENT || '2', 10);
        if (isNaN(minAgreement) || minAgreement < 1) {
            throw new Error(
                `Invalid CONSENSUS_MIN_AGREEMENT: ${process.env.CONSENSUS_MIN_AGREEMENT}. Must be a positive integer.`
            );
        }

        const consensusWindow = parseInt(process.env.CONSENSUS_WINDOW_SECONDS || '300', 10);
        if (isNaN(consensusWindow) || consensusWindow < 10) {
            throw new Error(
                `Invalid CONSENSUS_WINDOW_SECONDS: ${process.env.CONSENSUS_WINDOW_SECONDS}. Must be at least 10 seconds.`
            );
        }

        const applyTo = (process.env.CONSENSUS_APPLY_TO || 'BUY').toUpperCase();
        if (!['BUY', 'SELL', 'BOTH'].includes(applyTo)) {
            throw new Error(
                `Invalid CONSENSUS_APPLY_TO: ${process.env.CONSENSUS_APPLY_TO}. Must be BUY, SELL, or BOTH.`
            );
        }

        const sizeMode = (process.env.CONSENSUS_SIZE_MODE || 'AVERAGE').toUpperCase();
        if (!['AVERAGE', 'LARGEST', 'FIRST', 'MEDIAN'].includes(sizeMode)) {
            throw new Error(
                `Invalid CONSENSUS_SIZE_MODE: ${process.env.CONSENSUS_SIZE_MODE}. Must be AVERAGE, LARGEST, FIRST, or MEDIAN.`
            );
        }
    }
};

/**
 * Validate URL formats
 */
const validateUrls = (): void => {
    if (process.env.CLOB_HTTP_URL && !process.env.CLOB_HTTP_URL.startsWith('http')) {
        throw new Error(
            `Invalid CLOB_HTTP_URL: ${process.env.CLOB_HTTP_URL}. Must be a valid HTTP/HTTPS URL.`
        );
    }

    if (process.env.CLOB_WS_URL && !process.env.CLOB_WS_URL.startsWith('ws')) {
        throw new Error(
            `Invalid CLOB_WS_URL: ${process.env.CLOB_WS_URL}. Must be a valid WebSocket URL (ws:// or wss://).`
        );
    }

    if (process.env.RPC_URL && !process.env.RPC_URL.startsWith('http')) {
        throw new Error(`Invalid RPC_URL: ${process.env.RPC_URL}. Must be a valid HTTP/HTTPS URL.`);
    }

    if (process.env.MONGO_URI && !process.env.MONGO_URI.startsWith('mongodb')) {
        throw new Error(
            `Invalid MONGO_URI: ${process.env.MONGO_URI}. Must be a valid MongoDB connection string.`
        );
    }
};

// Run all validations
validateRequiredEnv();
validateAddresses();
validateNumericConfig();
validateUrls();

/**
 * Soft-parse optional legacy USER_ADDRESSES (comma / JSON). Invalid tokens skipped.
 * Runtime traders come from Mongo via applyRuntimeOverrides — env is not authoritative.
 */
const softParseUserAddresses = (input: string | undefined): string[] => {
    const trimmed = (input || '').trim();
    if (!trimmed) return [];

    let tokens: string[] = [];
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                tokens = parsed.map((addr) => String(addr).toLowerCase().trim());
            }
        } catch {
            tokens = trimmed.split(/[\s,]+/).map((addr) => addr.toLowerCase().trim());
        }
    } else {
        tokens = trimmed.split(',').map((addr) => addr.toLowerCase().trim());
    }

    const out: string[] = [];
    const seen = new Set<string>();
    for (const addr of tokens) {
        if (!addr || !isValidEthereumAddress(addr) || seen.has(addr)) continue;
        seen.add(addr);
        out.push(addr);
    }
    return out;
};

// Parse copy strategy configuration
const parseCopyStrategy = (): CopyStrategyConfig => {
    // Support legacy COPY_PERCENTAGE + TRADE_MULTIPLIER for backward compatibility
    const hasLegacyConfig = process.env.COPY_PERCENTAGE && !process.env.COPY_STRATEGY;

    if (hasLegacyConfig) {
        console.warn(
            '⚠️  Using legacy COPY_PERCENTAGE configuration. Consider migrating to COPY_STRATEGY.'
        );
        const copyPercentage = parseFloat(process.env.COPY_PERCENTAGE || '10.0');
        const tradeMultiplier = parseFloat(process.env.TRADE_MULTIPLIER || '1.0');
        const effectivePercentage = copyPercentage * tradeMultiplier;

        const config: CopyStrategyConfig = {
            strategy: CopyStrategy.PERCENTAGE,
            copySize: effectivePercentage,
            maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
            minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
            maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
                ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
                : undefined,
            maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
                ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
                : undefined,
        };

        // Parse tiered multipliers if configured (even for legacy mode)
        if (process.env.TIERED_MULTIPLIERS) {
            try {
                config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
                console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
            } catch (error) {
                throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
            }
        } else if (tradeMultiplier !== 1.0) {
            // If using legacy single multiplier, store it
            config.tradeMultiplier = tradeMultiplier;
        }

        return config;
    }

    // Parse new copy strategy configuration
    const strategyStr = (process.env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase();
    const strategy =
        CopyStrategy[strategyStr as keyof typeof CopyStrategy] || CopyStrategy.PERCENTAGE;

    const config: CopyStrategyConfig = {
        strategy,
        copySize: parseFloat(process.env.COPY_SIZE || '10.0'),
        maxOrderSizeUSD: parseFloat(process.env.MAX_ORDER_SIZE_USD || '100.0'),
        minOrderSizeUSD: parseFloat(process.env.MIN_ORDER_SIZE_USD || '1.0'),
        maxPositionSizeUSD: process.env.MAX_POSITION_SIZE_USD
            ? parseFloat(process.env.MAX_POSITION_SIZE_USD)
            : undefined,
        maxDailyVolumeUSD: process.env.MAX_DAILY_VOLUME_USD
            ? parseFloat(process.env.MAX_DAILY_VOLUME_USD)
            : undefined,
    };

    // Add adaptive strategy parameters if applicable
    if (strategy === CopyStrategy.ADAPTIVE) {
        config.adaptiveMinPercent = parseFloat(
            process.env.ADAPTIVE_MIN_PERCENT || config.copySize.toString()
        );
        config.adaptiveMaxPercent = parseFloat(
            process.env.ADAPTIVE_MAX_PERCENT || config.copySize.toString()
        );
        config.adaptiveThreshold = parseFloat(process.env.ADAPTIVE_THRESHOLD_USD || '500.0');
    }

    // Kelly / half-Kelly parameters
    if (strategy === CopyStrategy.KELLY) {
        config.kellyFraction = parseFloat(process.env.KELLY_FRACTION || '0.5'); // half Kelly
        config.kellyEdge = parseFloat(process.env.KELLY_EDGE || '0.05');
        config.kellyMaxFraction = parseFloat(process.env.KELLY_MAX_FRACTION || '0.25');
        console.log(
            `✓ Kelly sizing: ${config.kellyFraction}x Kelly, edge +${((config.kellyEdge || 0) * 100).toFixed(1)}pp, max ${(config.kellyMaxFraction || 0) * 100}% of bankroll`
        );
    }

    // Always parse martingale knobs (so Settings can switch without restart gaps)
    config.martingaleBaseShares = parseFloat(process.env.MARTINGALE_BASE_SHARES || '5');
    config.martingaleMaxSteps = parseInt(process.env.MARTINGALE_MAX_STEPS || '8', 10);
    if (strategy === CopyStrategy.MARTINGALE) {
        console.log(
            `✓ Martingale sizing: base ${config.martingaleBaseShares} shares, max ${config.martingaleMaxSteps} doubles (ignores trader size)`
        );
    }

    // Parse tiered multipliers if configured
    if (process.env.TIERED_MULTIPLIERS) {
        try {
            config.tieredMultipliers = parseTieredMultipliers(process.env.TIERED_MULTIPLIERS);
            console.log(`✓ Loaded ${config.tieredMultipliers.length} tiered multipliers`);
        } catch (error) {
            throw new Error(`Failed to parse TIERED_MULTIPLIERS: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else if (process.env.TRADE_MULTIPLIER) {
        // Fall back to single multiplier if no tiers configured
        const singleMultiplier = parseFloat(process.env.TRADE_MULTIPLIER);
        if (singleMultiplier !== 1.0) {
            config.tradeMultiplier = singleMultiplier;
            console.log(`✓ Using single trade multiplier: ${singleMultiplier}x`);
        }
    }

    return config;
};

export const ENV = {
    /** Mutated in place by applyRuntimeOverrides from Mongo (dashboard). */
    USER_ADDRESSES: softParseUserAddresses(process.env.USER_ADDRESSES),
    PROXY_WALLET: (process.env.PROXY_WALLET || '') as string,
    PRIVATE_KEY: (process.env.PRIVATE_KEY || '') as string,
    /**
     * Polymarket signature type for CLOB orders:
     * 0=EOA, 1=POLY_PROXY, 2=POLY_GNOSIS_SAFE, 3=POLY_1271 (deposit wallet).
     * Empty = auto-detect (Safe vs EOA).
     */
    POLY_SIGNATURE_TYPE: (process.env.POLY_SIGNATURE_TYPE || '').trim(),
    /** Relayer API key (gasless wallet ops; optional for CLOB if allowances already set). */
    RELAYER_API_KEY: (process.env.RELAYER_API_KEY || '').trim(),
    RELAYER_API_KEY_ADDRESS: (process.env.RELAYER_API_KEY_ADDRESS || '').trim(),
    CLOB_HTTP_URL: process.env.CLOB_HTTP_URL as string,
    CLOB_WS_URL: process.env.CLOB_WS_URL as string,
    /** Monitor/simulate only — wallet + private key optional */
    PAPER_MODE: PAPER_MODE_ENABLED,
    /** Alias of PAPER_MODE (legacy name) */
    PREVIEW_MODE: PAPER_MODE_ENABLED,
    /** Virtual USDC balance used for sizing when PAPER_MODE and no real wallet balance */
    PAPER_BALANCE_USD: parseFloat(process.env.PAPER_BALANCE_USD || '10000'),
    FETCH_INTERVAL: parseInt(process.env.FETCH_INTERVAL || '1', 10),
    TOO_OLD_TIMESTAMP: parseInt(process.env.TOO_OLD_TIMESTAMP || '24', 10),
    RETRY_LIMIT: parseInt(process.env.RETRY_LIMIT || '3', 10),
    // Legacy parameters (kept for backward compatibility)
    TRADE_MULTIPLIER: parseFloat(process.env.TRADE_MULTIPLIER || '1.0'),
    COPY_PERCENTAGE: parseFloat(process.env.COPY_PERCENTAGE || '10.0'),
    // New copy strategy configuration
    COPY_STRATEGY_CONFIG: parseCopyStrategy(),
    // Network settings
    REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || '10000', 10),
    NETWORK_RETRY_LIMIT: parseInt(process.env.NETWORK_RETRY_LIMIT || '3', 10),
    // Trade aggregation settings
    TRADE_AGGREGATION_ENABLED: process.env.TRADE_AGGREGATION_ENABLED === 'true',
    TRADE_AGGREGATION_WINDOW_SECONDS: parseInt(
        process.env.TRADE_AGGREGATION_WINDOW_SECONDS || '300',
        10
    ), // 5 minutes default
    MONGO_URI: process.env.MONGO_URI as string,
    RPC_URL: process.env.RPC_URL as string,
    USDC_CONTRACT_ADDRESS: process.env.USDC_CONTRACT_ADDRESS as string,
    // Auto-resolve settings (automatically sell positions at 100% or 0%)
    AUTO_RESOLVE_ENABLED: process.env.AUTO_RESOLVE_ENABLED === 'true',
    AUTO_RESOLVE_INTERVAL: parseInt(process.env.AUTO_RESOLVE_INTERVAL || '60', 10), // Check every 60s by default
    /**
     * Live-only: when CLOB cash doubles past the ladder baseline, withdraw
     * (baseline − $50) to the connected wallet (EOA / AUTO_CLAIM_RECIPIENT).
     * Default on unless explicitly set to false.
     */
    AUTO_CLAIM_ENABLED: process.env.AUTO_CLAIM_ENABLED !== 'false',
    /** Seconds between auto-claim cash checks. Default 86400 = once per day. */
    AUTO_CLAIM_INTERVAL: parseInt(process.env.AUTO_CLAIM_INTERVAL || '86400', 10),
    /**
     * Optional auto-claim payout destination (EOA that receives withdrawn USDC/pUSD).
     * PAYOUT_ADDRESS is the preferred alias; AUTO_CLAIM_RECIPIENT is legacy.
     * Defaults to signer address from PRIVATE_KEY / POLY_PRIVATE_KEY when empty.
     */
    AUTO_CLAIM_RECIPIENT: (
        process.env.PAYOUT_ADDRESS ||
        process.env.AUTO_CLAIM_RECIPIENT ||
        ''
    ).trim(),
    /** Preferred alias for AUTO_CLAIM_RECIPIENT. */
    PAYOUT_ADDRESS: (
        process.env.PAYOUT_ADDRESS ||
        process.env.AUTO_CLAIM_RECIPIENT ||
        ''
    ).trim(),
    // Consensus / multi-trader agreement settings
    CONSENSUS_ENABLED: process.env.CONSENSUS_ENABLED === 'true',
    CONSENSUS_MIN_AGREEMENT: parseInt(process.env.CONSENSUS_MIN_AGREEMENT || '6', 10),
    CONSENSUS_WINDOW_SECONDS: parseInt(process.env.CONSENSUS_WINDOW_SECONDS || '300', 10),
    CONSENSUS_APPLY_TO: (process.env.CONSENSUS_APPLY_TO || 'BUY').toUpperCase() as
        | 'BUY'
        | 'SELL'
        | 'BOTH',
    CONSENSUS_SIZE_MODE: (process.env.CONSENSUS_SIZE_MODE || 'AVERAGE').toUpperCase() as
        | 'AVERAGE'
        | 'LARGEST'
        | 'FIRST'
        | 'MEDIAN',
    /**
     * Max allowed book slippage vs the last agreeing trader's fill price (± percent).
     * e.g. 15 → ask must be within [ref*0.85, ref*1.15] for BUYs.
     * Ignored when SKIP_PRICE_SLIPPAGE is true.
     */
    MAX_SLIPPAGE_PERCENT: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || '15'),
    /** When true, BUY orders skip the ±% book vs ref-price band check. */
    SKIP_PRICE_SLIPPAGE: ['true', '1', 'yes', 'on'].includes(
        (process.env.SKIP_PRICE_SLIPPAGE || '').toLowerCase()
    ),
    /**
     * Skip BUY entries when market/ask price is above this (default 0.90).
     * Near-certainty prices leave too little edge after maker/taker fees.
     */
    MAX_ENTRY_PRICE: parseFloat(process.env.MAX_ENTRY_PRICE || '0.90'),
    /**
     * Copy-trade execution style: taker (FOK market, default) or maker (GTC post-only).
     */
    ORDER_EXECUTION: ((): 'taker' | 'maker' => {
        const raw = (process.env.ORDER_EXECUTION || 'taker').trim().toLowerCase();
        return raw === 'maker' ? 'maker' : 'taker';
    })(),
    /**
     * When true (default): never buy the opposite outcome of a market we already hold.
     * When false: fall back to HEDGE_ARB_* market/limit behavior.
     */
    BLOCK_OPPOSITE_SIDE: process.env.BLOCK_OPPOSITE_SIDE !== 'false',
    /**
     * When true (default): skip additional BUYs on an outcome we already hold
     * if the ask is below our average entry (no averaging down).
     */
    BLOCK_AVERAGE_DOWN: process.env.BLOCK_AVERAGE_DOWN !== 'false',
    /**
     * When true (default): only one instrument per eventSlug / match family
     * (e.g. series OR game1 — not both).
     */
    BLOCK_EVENT_FAMILY: process.env.BLOCK_EVENT_FAMILY !== 'false',
    /** When true (default): skip Bitcoin/ETH/SOL "Up or Down" short-interval markets. */
    SKIP_CRYPTO_UPDOWN: process.env.SKIP_CRYPTO_UPDOWN !== 'false',
    /**
     * Legacy: when BLOCK_OPPOSITE_SIDE=false, only market-buy the second side if
     * both legs stay under HEDGE_ARB_MAX_LEG and sum ≤ HEDGE_ARB_MAX_SUM.
     */
    HEDGE_ARB_ENABLED: process.env.HEDGE_ARB_ENABLED !== 'false',
    HEDGE_ARB_MAX_SUM: parseFloat(process.env.HEDGE_ARB_MAX_SUM || '0.90'),
    HEDGE_ARB_MAX_LEG: parseFloat(process.env.HEDGE_ARB_MAX_LEG || '0.90'),
    // Health HTTP server (Coolify / Docker healthchecks)
    HEALTH_PORT: parseInt(process.env.HEALTH_PORT || process.env.PORT || '3000', 10),
    /** Push trade fills via Gravia webhooks into Mongo (dashboard traders). */
    GRAVIA_FEED_ENABLED: ['true', '1', 'yes', 'on'].includes(
        (process.env.GRAVIA_FEED_ENABLED || 'true').toLowerCase()
    ),
    GRAVIA_API: (process.env.GRAVIA_API || process.env.GRAVIA_API_KEY || '').trim(),
    GRAVIA_SIGNING_SECRET: (process.env.GRAVIA_SIGNING_SECRET || '').trim(),
    GRAVIA_SUBSCRIPTION_ID: (process.env.GRAVIA_SUBSCRIPTION_ID || '').trim(),
    GRAVIA_PUBLIC_BASE_URL: (
        process.env.GRAVIA_PUBLIC_BASE_URL || 'https://btc.webwien.at'
    )
        .trim()
        .replace(/\/$/, ''),
    GRAVIA_WEBHOOK_PATH: (process.env.GRAVIA_WEBHOOK_PATH || '/api/webhooks/gravia').trim(),
    /**
     * When Gravia feed is on, Polymarket poll uses at least this many seconds
     * (fallback / catch-up). Override with FETCH_INTERVAL if higher.
     */
    GRAVIA_POLL_FALLBACK_SECONDS: parseInt(
        process.env.GRAVIA_POLL_FALLBACK_SECONDS || '90',
        10
    ),
};
