import * as fs from 'fs';
import * as path from 'path';
import { stripQuotes } from './env';

const ENV_PATH = path.join(process.cwd(), '..', '.env');

export function readEnvFileValue(key: string): string {
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    const match = fs
      .readFileSync(ENV_PATH, 'utf-8')
      .match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!match) return '';
    return stripQuotes(match[1]);
  } catch {
    return '';
  }
}

export function getProcessOrFileEnv(key: string): string {
  return stripQuotes(process.env[key] || readEnvFileValue(key) || '');
}

/**
 * Resolve trading wallet: PROXY_WALLET, else POLY_FUNDER (deposit wallet).
 */
export function resolveProxyWallet(
  overrides: Record<string, string> = {}
): string {
  const fromOverride = stripQuotes(overrides.PROXY_WALLET || overrides.POLY_FUNDER || '');
  if (fromOverride && /^0x[a-fA-F0-9]{40}$/i.test(fromOverride)) {
    return fromOverride.toLowerCase();
  }
  const proxy = getProcessOrFileEnv('PROXY_WALLET');
  if (proxy && /^0x[a-fA-F0-9]{40}$/i.test(proxy)) return proxy.toLowerCase();
  const funder = getProcessOrFileEnv('POLY_FUNDER');
  if (funder && /^0x[a-fA-F0-9]{40}$/i.test(funder)) return funder.toLowerCase();
  return '';
}

const truthy = (v: string) => ['true', '1', 'yes', 'on'].includes(v.toLowerCase());
const falsy = (v: string) => ['false', '0', 'no', 'off'].includes(v.toLowerCase());

/**
 * Coolify/process env wins when explicitly set (so PAPER_MODE=false goes live
 * even if Mongo still has an old paper=true Settings override).
 */
export function resolvePaperMode(overrides: Record<string, string> = {}): boolean {
  const envRaw =
    getProcessOrFileEnv('PAPER_MODE') || getProcessOrFileEnv('PREVIEW_MODE');
  if (envRaw) {
    if (falsy(envRaw)) return false;
    if (truthy(envRaw)) return true;
  }
  const mongoRaw = stripQuotes(
    overrides.PAPER_MODE || overrides.PREVIEW_MODE || ''
  );
  return truthy(mongoRaw);
}

/** Ask the bot process for CLOB collateral balance. */
export async function fetchBotClobBalance(): Promise<{
  usdc: number;
  proxyWallet: string;
  source: string;
} | null> {
  const healthPort = process.env.HEALTH_PORT || '3001';
  try {
    const res = await fetch(`http://127.0.0.1:${healthPort}/balance`, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      usdc?: number;
      proxyWallet?: string;
      source?: string;
    };
    if (body.ok === false || typeof body.usdc !== 'number') return null;
    return {
      usdc: body.usdc,
      proxyWallet: body.proxyWallet || '',
      source: body.source || 'clob',
    };
  } catch {
    return null;
  }
}
