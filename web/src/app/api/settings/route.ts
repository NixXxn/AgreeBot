import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import { BotSettings, SettingsResponse, SettingsUpdate } from '@/types/settings';
import {
  getMergedEnv,
  getRuntimeOverrides,
  normalizeTraderAddresses,
  saveRuntimeOverrides,
} from '@/lib/runtimeSettings';
import { stripQuotes } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ENV_PATH = path.join(process.cwd(), '..', '.env');
const REPORTS_DIR = path.join(process.cwd(), '..', 'trader_reports');

/** Ask the bot process to re-apply Mongo overrides (min agreement, strategy, …). */
async function notifyBotRuntimeReload(): Promise<{
  ok: boolean;
  message: string;
  minAgreement?: number;
  paperMode?: boolean;
  clobReady?: boolean;
}> {
  const healthPort = process.env.HEALTH_PORT || '3001';
  try {
    const res = await fetch(`http://127.0.0.1:${healthPort}/runtime/reload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      consensus?: { minAgreement?: number };
      traders?: number;
      paperMode?: boolean;
      clobReady?: boolean;
    };
    if (!res.ok || body.ok === false) {
      return {
        ok: false,
        message: body.error || `Bot reload failed (${res.status}) — restart the bot container`,
      };
    }
    return {
      ok: true,
      minAgreement: body.consensus?.minAgreement,
      paperMode: body.paperMode,
      clobReady: body.clobReady,
      message: `Bot reloaded (mode=${body.paperMode ? 'paper' : 'live'}, clob=${body.clobReady ? 'ready' : 'no'}, minAgreement=${body.consensus?.minAgreement ?? '?'}, traders=${body.traders ?? '?'})`,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Bot not notified (${error.message}) — restart the bot container`
          : 'Bot not notified — restart the bot container',
    };
  }
}

// Parse .env file into key-value pairs
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) continue;

    const key = trimmed.slice(0, equalIndex).trim();
    let value = trimmed.slice(equalIndex + 1).trim();

    value = stripQuotes(value);

    // Handle inline comments
    const commentIndex = value.indexOf(' #');
    if (commentIndex !== -1) {
      value = value.slice(0, commentIndex).trim();
    }

    result[key] = value;
  }

  return result;
}

// Convert env values to BotSettings
function envToSettings(env: Record<string, string>): BotSettings {
  // Parse USER_ADDRESSES (can be comma-separated or JSON array)
  let traders: string[] = [];
  const userAddresses = stripQuotes(env.USER_ADDRESSES || '');
  if (userAddresses.trim().startsWith('[')) {
    try {
      traders = normalizeTraderAddresses(JSON.parse(userAddresses) as string[]);
    } catch {
      traders = normalizeTraderAddresses(userAddresses.split(','));
    }
  } else if (userAddresses.trim()) {
    traders = normalizeTraderAddresses(userAddresses.split(','));
  }

  return {
    traders,
    copyStrategy: {
      strategy: (env.COPY_STRATEGY || 'PERCENTAGE').toUpperCase() as BotSettings['copyStrategy']['strategy'],
      copySize: parseFloat(env.COPY_SIZE || env.COPY_PERCENTAGE || '10'),
      tradeMultiplier: parseFloat(env.TRADE_MULTIPLIER || '1'),
      tieredMultipliers: env.TIERED_MULTIPLIERS || null,
      kellyFraction: parseFloat(env.KELLY_FRACTION || '0.5'),
      kellyEdge: parseFloat(env.KELLY_EDGE || '0.05'),
      kellyMaxFraction: parseFloat(env.KELLY_MAX_FRACTION || '0.25'),
    },
    safetyLimits: {
      maxOrderSizeUSD: parseFloat(env.MAX_ORDER_SIZE_USD || '100'),
      minOrderSizeUSD: parseFloat(env.MIN_ORDER_SIZE_USD || '1'),
      maxPositionSizeUSD: env.MAX_POSITION_SIZE_USD ? parseFloat(env.MAX_POSITION_SIZE_USD) : null,
      maxDailyVolumeUSD: env.MAX_DAILY_VOLUME_USD ? parseFloat(env.MAX_DAILY_VOLUME_USD) : null,
    },
    adaptiveStrategy: {
      minPercent: parseFloat(env.ADAPTIVE_MIN_PERCENT || '5'),
      maxPercent: parseFloat(env.ADAPTIVE_MAX_PERCENT || '20'),
      thresholdUSD: parseFloat(env.ADAPTIVE_THRESHOLD_USD || '500'),
    },
    botSettings: {
      fetchInterval: parseInt(env.FETCH_INTERVAL || '1', 10),
      tooOldTimestamp: parseInt(env.TOO_OLD_TIMESTAMP || '24', 10),
      retryLimit: parseInt(env.RETRY_LIMIT || '3', 10),
      tradeAggregationEnabled: env.TRADE_AGGREGATION_ENABLED === 'true',
      tradeAggregationWindowSeconds: parseInt(env.TRADE_AGGREGATION_WINDOW_SECONDS || '300', 10),
      previewMode: (() => {
        const raw = stripQuotes(env.PAPER_MODE || env.PREVIEW_MODE || '');
        if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
        return raw.toLowerCase() === 'true' || raw === '1' || raw.toLowerCase() === 'yes';
      })(),
      consensusEnabled: env.CONSENSUS_ENABLED === 'true',
      consensusMinAgreement: parseInt(env.CONSENSUS_MIN_AGREEMENT || '2', 10) || 2,
      consensusWindowSeconds: parseInt(env.CONSENSUS_WINDOW_SECONDS || '300', 10) || 300,
      consensusApplyTo: (['BUY', 'SELL', 'BOTH'].includes((env.CONSENSUS_APPLY_TO || 'BUY').toUpperCase())
        ? (env.CONSENSUS_APPLY_TO || 'BUY').toUpperCase()
        : 'BUY') as BotSettings['botSettings']['consensusApplyTo'],
      consensusSizeMode: (['AVERAGE', 'LARGEST', 'FIRST', 'MEDIAN'].includes((env.CONSENSUS_SIZE_MODE || 'AVERAGE').toUpperCase())
        ? (env.CONSENSUS_SIZE_MODE || 'AVERAGE').toUpperCase()
        : 'AVERAGE') as BotSettings['botSettings']['consensusSizeMode'],
    },
    network: {
      requestTimeoutMs: parseInt(env.REQUEST_TIMEOUT_MS || '10000', 10),
      networkRetryLimit: parseInt(env.NETWORK_RETRY_LIMIT || '3', 10),
    },
    wallet: {
      proxyWallet: stripQuotes(
        env.PROXY_WALLET || env.POLY_FUNDER || ''
      ),
      usdcContract: stripQuotes(
        env.USDC_CONTRACT_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
      ),
    },
  };
}

// Get trader labels from trader_reports
function getTraderLabels(): Record<string, string> {
  const labels: Record<string, string> = {};

  try {
    if (fs.existsSync(REPORTS_DIR)) {
      const summaryPath = path.join(REPORTS_DIR, '_SUMMARY.json');
      if (fs.existsSync(summaryPath)) {
        const data = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
        for (const trader of data) {
          if (trader.address && trader.label) {
            labels[trader.address.toLowerCase()] = trader.label;
          }
        }
      }
    }
  } catch (error) {
    console.error('Error reading trader labels:', error);
  }

  return labels;
}

// Update .env file with new settings
function updateEnvFile(envContent: string, updates: Record<string, string | null>): string {
  const lines = envContent.split('\n');
  const updatedKeys = new Set<string>();

  // Update existing lines
  const updatedLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex === -1) return line;

    const key = trimmed.slice(0, equalIndex).trim();

    if (key in updates) {
      updatedKeys.add(key);
      const value = updates[key];
      if (value === null) {
        // Comment out the line
        return `# ${line}`;
      }
      // Keep any leading whitespace from original line
      const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
      return `${leadingWhitespace}${key} = ${formatEnvValue(value)}`;
    }

    return line;
  });

  // Add new keys that weren't in the file
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key) && value !== null) {
      updatedLines.push(`${key} = ${formatEnvValue(value)}`);
    }
  }

  return updatedLines.join('\n');
}

// Format value for .env file
function formatEnvValue(value: string): string {
  // If value contains spaces or special chars, wrap in quotes
  if (value.includes(' ') || value.includes(',') || value.includes('#')) {
    return `'${value}'`;
  }
  return value;
}

// Convert settings update to env key-value pairs
function settingsToEnvUpdates(update: SettingsUpdate): Record<string, string | null> {
  const envUpdates: Record<string, string | null> = {};

  if (update.traders !== undefined) {
    // Always persist (including empty) so Coolify's USER_ADDRESSES cannot resurrect
    const normalized = normalizeTraderAddresses(update.traders);
    envUpdates.USER_ADDRESSES = normalized.join(',');
  }

  if (update.copyStrategy) {
    if (update.copyStrategy.strategy !== undefined) {
      envUpdates.COPY_STRATEGY = update.copyStrategy.strategy;
    }
    if (update.copyStrategy.copySize !== undefined) {
      envUpdates.COPY_SIZE = update.copyStrategy.copySize.toString();
      envUpdates.COPY_PERCENTAGE = update.copyStrategy.copySize.toString();
    }
    if (update.copyStrategy.tradeMultiplier !== undefined) {
      envUpdates.TRADE_MULTIPLIER = update.copyStrategy.tradeMultiplier.toString();
    }
    if (update.copyStrategy.tieredMultipliers !== undefined) {
      envUpdates.TIERED_MULTIPLIERS = update.copyStrategy.tieredMultipliers || '';
    }
    if (update.copyStrategy.kellyFraction !== undefined) {
      envUpdates.KELLY_FRACTION = update.copyStrategy.kellyFraction.toString();
    }
    if (update.copyStrategy.kellyEdge !== undefined) {
      envUpdates.KELLY_EDGE = update.copyStrategy.kellyEdge.toString();
    }
    if (update.copyStrategy.kellyMaxFraction !== undefined) {
      envUpdates.KELLY_MAX_FRACTION = update.copyStrategy.kellyMaxFraction.toString();
    }
  }

  if (update.safetyLimits) {
    if (update.safetyLimits.maxOrderSizeUSD !== undefined) {
      envUpdates.MAX_ORDER_SIZE_USD = update.safetyLimits.maxOrderSizeUSD.toString();
    }
    if (update.safetyLimits.minOrderSizeUSD !== undefined) {
      envUpdates.MIN_ORDER_SIZE_USD = update.safetyLimits.minOrderSizeUSD.toString();
    }
    if (update.safetyLimits.maxPositionSizeUSD !== undefined) {
      envUpdates.MAX_POSITION_SIZE_USD = update.safetyLimits.maxPositionSizeUSD?.toString() || '';
    }
    if (update.safetyLimits.maxDailyVolumeUSD !== undefined) {
      envUpdates.MAX_DAILY_VOLUME_USD = update.safetyLimits.maxDailyVolumeUSD?.toString() || '';
    }
  }

  if (update.adaptiveStrategy) {
    if (update.adaptiveStrategy.minPercent !== undefined) {
      envUpdates.ADAPTIVE_MIN_PERCENT = update.adaptiveStrategy.minPercent.toString();
    }
    if (update.adaptiveStrategy.maxPercent !== undefined) {
      envUpdates.ADAPTIVE_MAX_PERCENT = update.adaptiveStrategy.maxPercent.toString();
    }
    if (update.adaptiveStrategy.thresholdUSD !== undefined) {
      envUpdates.ADAPTIVE_THRESHOLD_USD = update.adaptiveStrategy.thresholdUSD.toString();
    }
  }

  if (update.botSettings) {
    if (update.botSettings.fetchInterval !== undefined) {
      envUpdates.FETCH_INTERVAL = update.botSettings.fetchInterval.toString();
    }
    if (update.botSettings.tooOldTimestamp !== undefined) {
      envUpdates.TOO_OLD_TIMESTAMP = update.botSettings.tooOldTimestamp.toString();
    }
    if (update.botSettings.retryLimit !== undefined) {
      envUpdates.RETRY_LIMIT = update.botSettings.retryLimit.toString();
    }
    if (update.botSettings.tradeAggregationEnabled !== undefined) {
      envUpdates.TRADE_AGGREGATION_ENABLED = update.botSettings.tradeAggregationEnabled.toString();
    }
    if (update.botSettings.tradeAggregationWindowSeconds !== undefined) {
      envUpdates.TRADE_AGGREGATION_WINDOW_SECONDS = update.botSettings.tradeAggregationWindowSeconds.toString();
    }
    if (update.botSettings.previewMode !== undefined) {
      // Bot checks PAPER_MODE; PREVIEW_MODE is the legacy alias — keep both in sync
      envUpdates.PREVIEW_MODE = update.botSettings.previewMode.toString();
      envUpdates.PAPER_MODE = update.botSettings.previewMode.toString();
    }
    if (update.botSettings.consensusEnabled !== undefined) {
      envUpdates.CONSENSUS_ENABLED = update.botSettings.consensusEnabled.toString();
    }
    if (update.botSettings.consensusMinAgreement !== undefined) {
      envUpdates.CONSENSUS_MIN_AGREEMENT = update.botSettings.consensusMinAgreement.toString();
    }
    if (update.botSettings.consensusWindowSeconds !== undefined) {
      envUpdates.CONSENSUS_WINDOW_SECONDS = update.botSettings.consensusWindowSeconds.toString();
    }
    if (update.botSettings.consensusApplyTo !== undefined) {
      envUpdates.CONSENSUS_APPLY_TO = update.botSettings.consensusApplyTo;
    }
    if (update.botSettings.consensusSizeMode !== undefined) {
      envUpdates.CONSENSUS_SIZE_MODE = update.botSettings.consensusSizeMode;
    }
  }

  if (update.network) {
    if (update.network.requestTimeoutMs !== undefined) {
      envUpdates.REQUEST_TIMEOUT_MS = update.network.requestTimeoutMs.toString();
    }
    if (update.network.networkRetryLimit !== undefined) {
      envUpdates.NETWORK_RETRY_LIMIT = update.network.networkRetryLimit.toString();
    }
  }

  return envUpdates;
}

function envFromProcess(): Record<string, string> {
  const keys = [
    'USER_ADDRESSES',
    'PROXY_WALLET',
    'PRIVATE_KEY',
    'MONGO_URI',
    'RPC_URL',
    'CLOB_HTTP_URL',
    'CLOB_WS_URL',
    'USDC_CONTRACT_ADDRESS',
    'COPY_STRATEGY',
    'COPY_SIZE',
    'COPY_PERCENTAGE',
    'TRADE_MULTIPLIER',
    'TIERED_MULTIPLIERS',
    'KELLY_FRACTION',
    'KELLY_EDGE',
    'KELLY_MAX_FRACTION',
    'MAX_ORDER_SIZE_USD',
    'MIN_ORDER_SIZE_USD',
    'MAX_POSITION_SIZE_USD',
    'MAX_DAILY_VOLUME_USD',
    'ADAPTIVE_MIN_PERCENT',
    'ADAPTIVE_MAX_PERCENT',
    'ADAPTIVE_THRESHOLD_USD',
    'FETCH_INTERVAL',
    'TOO_OLD_TIMESTAMP',
    'RETRY_LIMIT',
    'TRADE_AGGREGATION_ENABLED',
    'TRADE_AGGREGATION_WINDOW_SECONDS',
    'PREVIEW_MODE',
    'PAPER_MODE',
    'REQUEST_TIMEOUT_MS',
    'NETWORK_RETRY_LIMIT',
    'CONSENSUS_ENABLED',
    'CONSENSUS_MIN_AGREEMENT',
    'CONSENSUS_WINDOW_SECONDS',
    'CONSENSUS_APPLY_TO',
    'CONSENSUS_SIZE_MODE',
  ];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value !== undefined && value !== '') {
      env[key] = stripQuotes(value);
    }
  }
  return env;
}

async function buildEnvView(): Promise<Record<string, string>> {
  let env: Record<string, string> = {};

  if (fs.existsSync(ENV_PATH)) {
    const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    env = parseEnvFile(envContent);
  }

  // Coolify injects vars into process.env
  env = { ...env, ...envFromProcess() };

  // Dashboard saves win over Coolify (survive container restarts).
  // Require Mongo when MONGO_URI is set so we never silently show Coolify's list.
  const mongoConfigured = Boolean(
    process.env.MONGO_URI || env.MONGO_URI
  );
  env = await getMergedEnv(env, { required: mongoConfigured });

  // Polymarket aliases — wallet from POLY_FUNDER when PROXY_WALLET empty
  if (!stripQuotes(env.PROXY_WALLET || '') && stripQuotes(env.POLY_FUNDER || '')) {
    env.PROXY_WALLET = stripQuotes(env.POLY_FUNDER);
  }
  if (!stripQuotes(env.PRIVATE_KEY || '') && stripQuotes(env.POLY_PRIVATE_KEY || '')) {
    env.PRIVATE_KEY = stripQuotes(env.POLY_PRIVATE_KEY);
  }

  // Prefer the running bot's mode so Settings matches what actually trades
  try {
    const { fetchBotHealthMode } = await import('@/lib/botMode');
    const botMode = await fetchBotHealthMode();
    if (botMode) {
      env.PAPER_MODE = botMode.paperMode ? 'true' : 'false';
      env.PREVIEW_MODE = env.PAPER_MODE;
      env.BOT_MODE_SOURCE = botMode.source;
      env.BOT_CLOB_READY = botMode.clobReady ? 'true' : 'false';
    }
  } catch {
    /* bot unreachable — keep Mongo/env merge */
  }

  return env;
}

export async function GET() {
  try {
    const env = await buildEnvView();

    if (Object.keys(env).length === 0) {
      return NextResponse.json(
        { error: '.env file not found and no process env configured' },
        { status: 404 }
      );
    }

    const settings = envToSettings(env);
    const traderLabels = getTraderLabels();

    const response: SettingsResponse = {
      settings,
      traderLabels,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error reading settings:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to read settings',
      },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const update: SettingsUpdate = await request.json();

    if (update.traders !== undefined) {
      const normalized = normalizeTraderAddresses(update.traders);
      const invalid = update.traders.length - normalized.length;
      if (update.traders.length > 0 && normalized.length === 0) {
        return NextResponse.json(
          {
            error:
              'No valid Ethereum addresses in traders list (strip quotes and use 0x…40 hex chars)',
          },
          { status: 400 }
        );
      }
      update.traders = normalized;
      if (invalid > 0) {
        console.warn(`Dropped ${invalid} invalid trader address(es) on save`);
      }
    }

    const envUpdates = settingsToEnvUpdates(update);

    // Persist to Mongo so Coolify env + entrypoint rewrite cannot wipe traders
    try {
      await saveRuntimeOverrides(envUpdates);
    } catch (mongoError) {
      console.error('Mongo save failed:', mongoError);
      return NextResponse.json(
        {
          error:
            mongoError instanceof Error
              ? mongoError.message
              : 'Failed to persist settings to MongoDB',
        },
        { status: 500 }
      );
    }

    // Best-effort local .env write (useful for non-Docker; overwritten on Coolify restart)
    try {
      if (fs.existsSync(ENV_PATH)) {
        const envContent = fs.readFileSync(ENV_PATH, 'utf-8');
        const newEnvContent = updateEnvFile(envContent, envUpdates);
        fs.writeFileSync(ENV_PATH, newEnvContent, 'utf-8');
      }
    } catch (fileError) {
      console.warn('Could not write .env (Mongo save succeeded):', fileError);
    }

    const env = await buildEnvView();
    const settings = envToSettings(env);
    const traderLabels = getTraderLabels();

    // Confirm traders survived the Coolify→Mongo merge
    if (update.traders !== undefined) {
      const saved = settings.traders;
      const expected = update.traders;
      if (
        saved.length !== expected.length ||
        expected.some((addr, i) => saved[i] !== addr)
      ) {
        return NextResponse.json(
          {
            error:
              'Settings saved to Mongo but GET merge returned a different trader list — check MONGO_URI database name',
            settings,
            traderLabels,
          },
          { status: 500 }
        );
      }
    }

    const botReload = await notifyBotRuntimeReload();

    // Re-read after bot reload so previewMode matches the process that trades
    const envAfter = await buildEnvView();
    const settingsAfter = envToSettings(envAfter);

    return NextResponse.json({
      success: true,
      settings: settingsAfter,
      traderLabels,
      overrides: await getRuntimeOverrides().catch(() => ({})),
      botReload,
      message: botReload.ok
        ? `Settings saved. ${botReload.message} · mode=${settingsAfter.botSettings.previewMode ? 'paper' : 'live'}`
        : `Settings saved to MongoDB. ${botReload.message}`,
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to update settings',
      },
      { status: 500 }
    );
  }
}
