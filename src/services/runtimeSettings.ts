import { ENV } from '../config/env';
import { RuntimeSettings, RUNTIME_SETTINGS_ID } from '../models/runtimeSettings';
import Logger from '../utils/logger';

const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

const parseUserAddresses = (input: string): string[] => {
    const trimmed = input.trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((addr: string) => String(addr).toLowerCase().trim())
                    .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
            }
        } catch {
            /* fall through */
        }
    }

    return trimmed
        .split(',')
        .map((addr) => addr.toLowerCase().trim().replace(/^['"]|['"]$/g, ''))
        .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
};

export const getRuntimeOverrides = async (): Promise<Record<string, string>> => {
    try {
        const doc = await RuntimeSettings.findById(RUNTIME_SETTINGS_ID).lean().exec();
        if (!doc?.values || typeof doc.values !== 'object') return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(doc.values as Record<string, unknown>)) {
            if (v !== undefined && v !== null) out[k] = String(v);
        }
        return out;
    } catch (error) {
        Logger.warning(
            `Could not read runtime settings: ${error instanceof Error ? error.message : String(error)}`
        );
        return {};
    }
};

/**
 * Apply Mongo dashboard overrides on top of Coolify/process env.
 * Mutates ENV.USER_ADDRESSES in place so existing module refs stay valid.
 */
export const applyRuntimeOverrides = async (): Promise<void> => {
    const overrides = await getRuntimeOverrides();
    if (Object.keys(overrides).length === 0) {
        Logger.info('No dashboard runtime overrides in Mongo');
        return;
    }

    if (overrides.USER_ADDRESSES) {
        const addresses = parseUserAddresses(overrides.USER_ADDRESSES);
        if (addresses.length > 0) {
            ENV.USER_ADDRESSES.length = 0;
            ENV.USER_ADDRESSES.push(...addresses);
            Logger.success(
                `Loaded ${addresses.length} trader(s) from dashboard overrides (Mongo)`
            );
        }
    }

    if (overrides.CONSENSUS_ENABLED !== undefined) {
        ENV.CONSENSUS_ENABLED = overrides.CONSENSUS_ENABLED === 'true';
    }
    if (overrides.TRADE_AGGREGATION_ENABLED !== undefined) {
        ENV.TRADE_AGGREGATION_ENABLED = overrides.TRADE_AGGREGATION_ENABLED === 'true';
    }
    if (overrides.PREVIEW_MODE !== undefined) {
        ENV.PREVIEW_MODE = overrides.PREVIEW_MODE === 'true';
    }
    if (overrides.PAPER_MODE !== undefined) {
        ENV.PAPER_MODE = overrides.PAPER_MODE === 'true';
    }
    if (overrides.AUTO_RESOLVE_ENABLED !== undefined) {
        ENV.AUTO_RESOLVE_ENABLED = overrides.AUTO_RESOLVE_ENABLED === 'true';
    }

    if (overrides.CONSENSUS_MIN_AGREEMENT) {
        ENV.CONSENSUS_MIN_AGREEMENT = parseInt(overrides.CONSENSUS_MIN_AGREEMENT, 10) || 2;
    }
    if (overrides.CONSENSUS_WINDOW_SECONDS) {
        ENV.CONSENSUS_WINDOW_SECONDS = parseInt(overrides.CONSENSUS_WINDOW_SECONDS, 10) || 300;
    }
    if (overrides.CONSENSUS_APPLY_TO) {
        ENV.CONSENSUS_APPLY_TO = overrides.CONSENSUS_APPLY_TO.toUpperCase() as typeof ENV.CONSENSUS_APPLY_TO;
    }
    if (overrides.CONSENSUS_SIZE_MODE) {
        ENV.CONSENSUS_SIZE_MODE = overrides.CONSENSUS_SIZE_MODE.toUpperCase() as typeof ENV.CONSENSUS_SIZE_MODE;
    }
    if (overrides.FETCH_INTERVAL) {
        ENV.FETCH_INTERVAL = parseInt(overrides.FETCH_INTERVAL, 10) || ENV.FETCH_INTERVAL;
    }
    if (overrides.TOO_OLD_TIMESTAMP) {
        ENV.TOO_OLD_TIMESTAMP = parseInt(overrides.TOO_OLD_TIMESTAMP, 10) || ENV.TOO_OLD_TIMESTAMP;
    }
    if (overrides.RETRY_LIMIT) {
        ENV.RETRY_LIMIT = parseInt(overrides.RETRY_LIMIT, 10) || ENV.RETRY_LIMIT;
    }
    if (overrides.COPY_STRATEGY || overrides.COPY_SIZE || overrides.KELLY_FRACTION) {
        // Keep strategy config in sync when dashboard changes copy settings
        if (overrides.COPY_STRATEGY) {
            ENV.COPY_STRATEGY_CONFIG.strategy = overrides.COPY_STRATEGY.toUpperCase() as typeof ENV.COPY_STRATEGY_CONFIG.strategy;
        }
        if (overrides.COPY_SIZE) {
            ENV.COPY_STRATEGY_CONFIG.copySize = parseFloat(overrides.COPY_SIZE);
        }
        if (overrides.TRADE_MULTIPLIER) {
            ENV.COPY_STRATEGY_CONFIG.tradeMultiplier = parseFloat(overrides.TRADE_MULTIPLIER);
            ENV.TRADE_MULTIPLIER = parseFloat(overrides.TRADE_MULTIPLIER);
        }
        if (overrides.KELLY_FRACTION) {
            ENV.COPY_STRATEGY_CONFIG.kellyFraction = parseFloat(overrides.KELLY_FRACTION);
        }
        if (overrides.KELLY_EDGE) {
            ENV.COPY_STRATEGY_CONFIG.kellyEdge = parseFloat(overrides.KELLY_EDGE);
        }
        if (overrides.KELLY_MAX_FRACTION) {
            ENV.COPY_STRATEGY_CONFIG.kellyMaxFraction = parseFloat(overrides.KELLY_MAX_FRACTION);
        }
        if (overrides.MAX_ORDER_SIZE_USD) {
            ENV.COPY_STRATEGY_CONFIG.maxOrderSizeUSD = parseFloat(overrides.MAX_ORDER_SIZE_USD);
        }
        if (overrides.MIN_ORDER_SIZE_USD) {
            ENV.COPY_STRATEGY_CONFIG.minOrderSizeUSD = parseFloat(overrides.MIN_ORDER_SIZE_USD);
        }
    }
};
