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
            if (
                [
                    'PROXY_WALLET',
                    'PRIVATE_KEY',
                    'MONGO_URI',
                    'RPC_URL',
                    'USER_ADDRESSES',
                ].includes(key)
            ) {
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

// Sensible defaults so paper mode can start with only USER_ADDRESSES + MONGO_URI
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
    // polygon-rpc.com returns 401 (tenant disabled) — use a working public endpoint
    process.env.RPC_URL = 'https://polygon-bor-rpc.publicnode.com';
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
    // Live trading needs a funded wallet. Paper mode only needs traders + MongoDB.
    const required = PAPER_MODE_ENABLED
        ? ['USER_ADDRESSES', 'MONGO_URI']
        : [
              'USER_ADDRESSES',
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
            ? `Paper mode is ON — only USER_ADDRESSES and MONGO_URI are required.\n`
            : `For paper/preview without a wallet, set PAPER_MODE=true (or PREVIEW_MODE=true).\n` +
              `Otherwise set PROXY_WALLET + PRIVATE_KEY for live trading.\n`;
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

// Parse USER_ADDRESSES: supports both comma-separated string and JSON array
const parseUserAddresses = (input: string): string[] => {
    const trimmed = input.trim();
    // Check if it's JSON array format
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                const addresses = parsed
                    .map((addr) => addr.toLowerCase().trim())
                    .filter((addr) => addr.length > 0);
                // Validate each address
                for (const addr of addresses) {
                    if (!isValidEthereumAddress(addr)) {
                        throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
                    }
                }
                return addresses;
            }
        } catch (e) {
            if (e instanceof Error && e.message.includes('Invalid Ethereum address')) {
                throw e;
            }
            throw new Error(
                `Invalid JSON format for USER_ADDRESSES: ${e instanceof Error ? e.message : String(e)}`
            );
        }
    }
    // Otherwise treat as comma-separated
    const addresses = trimmed
        .split(',')
        .map((addr) => addr.toLowerCase().trim())
        .filter((addr) => addr.length > 0);
    // Validate each address
    for (const addr of addresses) {
        if (!isValidEthereumAddress(addr)) {
            throw new Error(`Invalid Ethereum address in USER_ADDRESSES: ${addr}`);
        }
    }
    return addresses;
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
    USER_ADDRESSES: parseUserAddresses(process.env.USER_ADDRESSES as string),
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
    // Consensus / multi-trader agreement settings
    CONSENSUS_ENABLED: process.env.CONSENSUS_ENABLED === 'true',
    CONSENSUS_MIN_AGREEMENT: parseInt(process.env.CONSENSUS_MIN_AGREEMENT || '2', 10),
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
    // Health HTTP server (Coolify / Docker healthchecks)
    HEALTH_PORT: parseInt(process.env.HEALTH_PORT || process.env.PORT || '3000', 10),
};
