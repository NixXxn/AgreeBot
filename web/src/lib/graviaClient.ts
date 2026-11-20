import { getEnvValue } from './env';

const GRAVIA_BASE = 'https://data.gravia.trade';
/** Gravia rejects filter arrays larger than this. */
export const GRAVIA_MAX_WALLET_FILTER = 500;

export function getGraviaConfig() {
  const apiKey = getEnvValue('GRAVIA_API') || getEnvValue('GRAVIA_API_KEY');
  const signingSecret = getEnvValue('GRAVIA_SIGNING_SECRET');
  const subscriptionId = getEnvValue('GRAVIA_SUBSCRIPTION_ID');
  const publicBase = (
    getEnvValue('GRAVIA_PUBLIC_BASE_URL') || 'https://btc.webwien.at'
  ).replace(/\/$/, '');
  const webhookPath =
    getEnvValue('GRAVIA_WEBHOOK_PATH') || '/api/webhooks/gravia';
  const feedEnabled = ['true', '1', 'yes', 'on'].includes(
    (getEnvValue('GRAVIA_FEED_ENABLED') || 'true').toLowerCase()
  );

  return {
    apiKey,
    signingSecret,
    subscriptionId,
    publicBase,
    webhookPath,
    webhookUrl: `${publicBase}${webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`}`,
    feedEnabled,
  };
}

async function graviaFetch(
  path: string,
  init: RequestInit & { apiKey: string }
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const { apiKey, ...rest } = init;
  const res = await fetch(`${GRAVIA_BASE}${path}`, {
    ...rest,
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      ...(rest.headers || {}),
    },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * Point the existing subscription at our public webhook URL, activate it,
 * and replace wallet_addresses with the current dashboard trader list (max 500).
 */
export async function syncGraviaSubscription(wallets: string[]): Promise<{
  ok: boolean;
  message: string;
  status?: number;
}> {
  const cfg = getGraviaConfig();
  if (!cfg.feedEnabled) {
    return { ok: true, message: 'Gravia feed disabled — skipped subscription sync' };
  }
  if (!cfg.apiKey || !cfg.subscriptionId) {
    return {
      ok: false,
      message: 'GRAVIA_API / GRAVIA_SUBSCRIPTION_ID not configured',
    };
  }

  const wallet_addresses = wallets
    .map((w) => w.toLowerCase())
    .filter((w) => /^0x[a-f0-9]{40}$/.test(w))
    .slice(0, GRAVIA_MAX_WALLET_FILTER);

  const payload: Record<string, unknown> = {
    url: cfg.webhookUrl,
    status: 'active',
    description: 'AgreeBot trader feed',
    filters: {
      wallet_addresses,
    },
  };

  // Keep existing signing secret unless we need to re-set it
  if (cfg.signingSecret) {
    payload.secret = cfg.signingSecret;
  }

  const result = await graviaFetch(`/v1/webhooks/${cfg.subscriptionId}`, {
    method: 'PUT',
    apiKey: cfg.apiKey,
    body: JSON.stringify(payload),
  });

  if (!result.ok) {
    const msg =
      result.body &&
      typeof result.body === 'object' &&
      'message' in result.body &&
      (result.body as { message?: string }).message
        ? String((result.body as { message?: string }).message)
        : `HTTP ${result.status}`;
    return { ok: false, message: msg, status: result.status };
  }

  return {
    ok: true,
    message: `Gravia subscription active → ${cfg.webhookUrl} (${wallet_addresses.length} wallets)`,
    status: result.status,
  };
}

export async function sendGraviaTestCallback(): Promise<{
  ok: boolean;
  message: string;
  delivery?: unknown;
}> {
  const cfg = getGraviaConfig();
  if (!cfg.apiKey || !cfg.subscriptionId) {
    return { ok: false, message: 'GRAVIA_API / GRAVIA_SUBSCRIPTION_ID not configured' };
  }

  const result = await graviaFetch(`/v1/webhooks/${cfg.subscriptionId}/test`, {
    method: 'POST',
    apiKey: cfg.apiKey,
    body: '{}',
  });

  return {
    ok: result.ok,
    message: result.ok
      ? 'Test callback requested'
      : `Test failed HTTP ${result.status}`,
    delivery:
      result.body && typeof result.body === 'object' && 'data' in result.body
        ? (result.body as { data: unknown }).data
        : result.body,
  };
}
