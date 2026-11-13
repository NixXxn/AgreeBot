import { createHash } from 'crypto';
import { ENV } from '../config/env';
import { RuntimeSettings, RUNTIME_SETTINGS_ID } from '../models/runtimeSettings';
import Logger from '../utils/logger';

const isValidEthereumAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
};

const stripQuotes = (value: string): string => {
    let v = value.trim();
    for (let i = 0; i < 3; i++) {
        if (
            (v.startsWith("'") && v.endsWith("'")) ||
            (v.startsWith('"') && v.endsWith('"'))
        ) {
            v = v.slice(1, -1).trim();
            continue;
        }
        break;
    }
    return v;
};

const parseUserAddresses = (input: string): string[] => {
    const trimmed = stripQuotes(input);
    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((addr: string) => stripQuotes(String(addr)).toLowerCase())
                    .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
            }
        } catch {
            /* fall through */
        }
    }

    return trimmed
        .split(',')
        .map((addr) => stripQuotes(addr).toLowerCase())
        .filter((addr) => addr.length > 0 && isValidEthereumAddress(addr));
};

const fingerprintUserAddresses = (raw: string): string =>
    createHash('sha256').update(stripQuotes(raw)).digest('hex');

/**
 * When Coolify USER_ADDRESSES changes, copy it into Mongo so Settings/Coolify stay aligned.
 * First run: store fingerprint only (do not overwrite an existing Settings list).
 */
const syncCoolifyUserAddresses = async (): Promise<void> => {
    const coolifyRaw = stripQuotes(process.env.USER_ADDRESSES || '');
    const fp = fingerprintUserAddresses(coolifyRaw);
    const addresses = parseUserAddresses(coolifyRaw);

    try {
        const doc = await RuntimeSettings.findById(RUNTIME_SETTINGS_ID).lean().exec();
        const prevFp =
            doc && typeof (doc as { coolifyUserAddressesFp?: string }).coolifyUserAddressesFp === 'string'
                ? (doc as { coolifyUserAddressesFp?: string }).coolifyUserAddressesFp
                : undefined;

        if (prevFp === undefined) {
            // Fingerprint only — never touch `values` here (avoids path conflicts with paper sync)
            await RuntimeSettings.findByIdAndUpdate(
                RUNTIME_SETTINGS_ID,
                {
                    $set: { coolifyUserAddressesFp: fp, updatedAt: new Date() },
                },
                { upsert: true }
            );
            return;
        }

        if (prevFp === fp) return;

        if (addresses.length === 0) {
            await RuntimeSettings.findByIdAndUpdate(RUNTIME_SETTINGS_ID, {
                $set: { coolifyUserAddressesFp: fp, updatedAt: new Date() },
            });
            Logger.warning(
                'Coolify USER_ADDRESSES changed but parsed empty — keeping Mongo trader list'
            );
            return;
        }

        await RuntimeSettings.findByIdAndUpdate(
            RUNTIME_SETTINGS_ID,
            {
                $set: {
                    'values.USER_ADDRESSES': addresses.join(','),
                    coolifyUserAddressesFp: fp,
                    updatedAt: new Date(),
                },
            },
            { upsert: true }
        );

        Logger.success(
            `Coolify USER_ADDRESSES changed — adopted ${addresses.length} trader(s) into Mongo`
        );
    } catch (error) {
        Logger.warning(
            `Could not sync Coolify USER_ADDRESSES: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
};

/**
 * Frozen at module load (container start) — Coolify/entrypoint value before Mongo
 * overrides mutate process.env.PAPER_MODE.
 */
const BOOT_PAPER_MODE_RAW = stripQuotes(
    process.env.PAPER_MODE !== undefined && process.env.PAPER_MODE !== ''
        ? process.env.PAPER_MODE
        : process.env.PREVIEW_MODE || ''
);

/**
 * When Coolify PAPER_MODE / PREVIEW_MODE changes, adopt into Mongo so live/paper toggles stick.
 */
const syncCoolifyPaperMode = async (): Promise<void> => {
    const raw = BOOT_PAPER_MODE_RAW;
    const fp = fingerprintUserAddresses(`paper:${raw}`);
    const paperOn = ['true', '1', 'yes', 'on'].includes(raw.toLowerCase());

    try {
        const doc = await RuntimeSettings.findById(RUNTIME_SETTINGS_ID).lean().exec();
        const prevFp =
            doc &&
            typeof (doc as { coolifyPaperModeFp?: string }).coolifyPaperModeFp === 'string'
                ? (doc as { coolifyPaperModeFp?: string }).coolifyPaperModeFp
                : undefined;

        const existing =
            doc?.values && typeof doc.values === 'object'
                ? { ...(doc.values as Record<string, string>) }
                : {};

        // Baseline fingerprint on first boot. Only overwrite Mongo when Coolify itself changes —
        // dashboard Settings owns paper/live after that.
        // Never mix $set `values` with $setOnInsert `values` or concurrent whole-object replaces.
        if (prevFp === undefined) {
            await RuntimeSettings.findByIdAndUpdate(
                RUNTIME_SETTINGS_ID,
                {
                    $set: {
                        coolifyPaperModeFp: fp,
                        updatedAt: new Date(),
                    },
                },
                { upsert: true }
            );
            if (
                raw !== '' &&
                existing.PAPER_MODE === undefined &&
                existing.PREVIEW_MODE === undefined
            ) {
                await RuntimeSettings.findByIdAndUpdate(RUNTIME_SETTINGS_ID, {
                    $set: {
                        'values.PAPER_MODE': paperOn ? 'true' : 'false',
                        'values.PREVIEW_MODE': paperOn ? 'true' : 'false',
                        updatedAt: new Date(),
                    },
                });
            }
            return;
        }

        if (prevFp === fp) return;

        await RuntimeSettings.findByIdAndUpdate(RUNTIME_SETTINGS_ID, {
            $set: {
                coolifyPaperModeFp: fp,
                updatedAt: new Date(),
            },
        });
        await RuntimeSettings.findByIdAndUpdate(RUNTIME_SETTINGS_ID, {
            $set: {
                'values.PAPER_MODE': paperOn ? 'true' : 'false',
                'values.PREVIEW_MODE': paperOn ? 'true' : 'false',
                updatedAt: new Date(),
            },
        });

        Logger.success(
            `Coolify PAPER_MODE changed — adopted ${paperOn ? 'paper' : 'live'} into Mongo`
        );
    } catch (error) {
        Logger.warning(
            `Could not sync Coolify PAPER_MODE: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
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
const isTruthy = (value: string | undefined): boolean =>
    ['true', '1', 'yes', 'on'].includes((value || '').trim().toLowerCase());

const isFalsy = (value: string | undefined): boolean =>
    ['false', '0', 'no', 'off'].includes((value || '').trim().toLowerCase());

/**
 * Dashboard Mongo Settings owns paper/live. Keep process.env in sync so later
 * reads (and child logic) see the same mode the bot is actually using.
 */
const applyPaperModeOverride = (overrides: Record<string, string>): void => {
    const before = ENV.PAPER_MODE;
    const mongoRaw = overrides.PAPER_MODE ?? overrides.PREVIEW_MODE;

    if (mongoRaw !== undefined) {
        if (isFalsy(mongoRaw)) {
            ENV.PAPER_MODE = false;
        } else if (isTruthy(mongoRaw)) {
            ENV.PAPER_MODE = true;
        }
    } else {
        const envRaw = process.env.PAPER_MODE || process.env.PREVIEW_MODE || '';
        if (isFalsy(envRaw)) ENV.PAPER_MODE = false;
        else if (isTruthy(envRaw)) ENV.PAPER_MODE = true;
    }

    ENV.PREVIEW_MODE = ENV.PAPER_MODE;
    process.env.PAPER_MODE = ENV.PAPER_MODE ? 'true' : 'false';
    process.env.PREVIEW_MODE = process.env.PAPER_MODE;

    if (before !== ENV.PAPER_MODE) {
        Logger.success(
            `Trading mode → ${ENV.PAPER_MODE ? 'PAPER' : 'LIVE'} (Mongo Settings)`
        );
    }
};

export const applyRuntimeOverrides = async (): Promise<void> => {
    await syncCoolifyUserAddresses();
    await syncCoolifyPaperMode();

    const overrides = await getRuntimeOverrides();

    // Always resolve paper/live — even when Mongo has no other overrides
    applyPaperModeOverride(overrides);

    if (Object.keys(overrides).length === 0) {
        Logger.info('No dashboard runtime overrides in Mongo');
        return;
    }

    // Explicit key means dashboard owns the list (including empty clear)
    if (Object.prototype.hasOwnProperty.call(overrides, 'USER_ADDRESSES')) {
        const addresses = parseUserAddresses(overrides.USER_ADDRESSES || '');
        ENV.USER_ADDRESSES.length = 0;
        ENV.USER_ADDRESSES.push(...addresses);
        Logger.success(
            `Loaded ${addresses.length} trader(s) from dashboard overrides (Mongo)`
        );
    }

    if (overrides.CONSENSUS_ENABLED !== undefined) {
        ENV.CONSENSUS_ENABLED = overrides.CONSENSUS_ENABLED === 'true';
    }
    if (overrides.TRADE_AGGREGATION_ENABLED !== undefined) {
        ENV.TRADE_AGGREGATION_ENABLED = overrides.TRADE_AGGREGATION_ENABLED === 'true';
    }
    if (overrides.AUTO_RESOLVE_ENABLED !== undefined) {
        ENV.AUTO_RESOLVE_ENABLED = overrides.AUTO_RESOLVE_ENABLED === 'true';
    }
    if (overrides.AUTO_CLAIM_ENABLED !== undefined) {
        ENV.AUTO_CLAIM_ENABLED = overrides.AUTO_CLAIM_ENABLED !== 'false';
    }
    if (overrides.AUTO_CLAIM_INTERVAL) {
        const n = parseInt(overrides.AUTO_CLAIM_INTERVAL, 10);
        if (Number.isFinite(n) && n > 0) ENV.AUTO_CLAIM_INTERVAL = n;
    }
    if (overrides.AUTO_CLAIM_RECIPIENT !== undefined) {
        ENV.AUTO_CLAIM_RECIPIENT = (overrides.AUTO_CLAIM_RECIPIENT || '').trim();
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
    if (overrides.MAX_SLIPPAGE_PERCENT) {
        const slip = parseFloat(overrides.MAX_SLIPPAGE_PERCENT);
        if (Number.isFinite(slip) && slip > 0) ENV.MAX_SLIPPAGE_PERCENT = slip;
    }
    if (overrides.SKIP_PRICE_SLIPPAGE !== undefined) {
        ENV.SKIP_PRICE_SLIPPAGE = ['true', '1', 'yes', 'on'].includes(
            overrides.SKIP_PRICE_SLIPPAGE.toLowerCase()
        );
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
    // Keep strategy / safety config in sync when dashboard changes settings
    if (overrides.COPY_STRATEGY) {
        ENV.COPY_STRATEGY_CONFIG.strategy =
            overrides.COPY_STRATEGY.toUpperCase() as typeof ENV.COPY_STRATEGY_CONFIG.strategy;
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
    if (overrides.MAX_POSITION_SIZE_USD) {
        ENV.COPY_STRATEGY_CONFIG.maxPositionSizeUSD = parseFloat(overrides.MAX_POSITION_SIZE_USD);
    }
    if (overrides.MAX_DAILY_VOLUME_USD) {
        ENV.COPY_STRATEGY_CONFIG.maxDailyVolumeUSD = parseFloat(overrides.MAX_DAILY_VOLUME_USD);
    }
    if (overrides.ADAPTIVE_MIN_PERCENT) {
        ENV.COPY_STRATEGY_CONFIG.adaptiveMinPercent = parseFloat(overrides.ADAPTIVE_MIN_PERCENT);
    }
    if (overrides.ADAPTIVE_MAX_PERCENT) {
        ENV.COPY_STRATEGY_CONFIG.adaptiveMaxPercent = parseFloat(overrides.ADAPTIVE_MAX_PERCENT);
    }
    if (overrides.ADAPTIVE_THRESHOLD_USD) {
        ENV.COPY_STRATEGY_CONFIG.adaptiveThreshold = parseFloat(overrides.ADAPTIVE_THRESHOLD_USD);
    }
    if (overrides.REQUEST_TIMEOUT_MS) {
        ENV.REQUEST_TIMEOUT_MS = parseInt(overrides.REQUEST_TIMEOUT_MS, 10) || ENV.REQUEST_TIMEOUT_MS;
    }
    if (overrides.NETWORK_RETRY_LIMIT) {
        ENV.NETWORK_RETRY_LIMIT =
            parseInt(overrides.NETWORK_RETRY_LIMIT, 10) || ENV.NETWORK_RETRY_LIMIT;
    }
};
