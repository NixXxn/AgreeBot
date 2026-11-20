import { createHmac, timingSafeEqual } from 'crypto';

export type GraviaWebhookEnvelope = {
  id?: string;
  event?: string;
  data?: Record<string, unknown>;
  timestamp?: number;
  webhook_id?: string;
  attempt?: number;
};

export type NormalizedGraviaActivity = {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;
  side: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  name: string;
  pseudonym: string;
  bio: string;
  profileImage: string;
  profileImageOptimized: string;
  bot: boolean;
  botExcutedTime: number;
  source: 'gravia';
  graviaDeliveryId?: string;
};

function str(v: unknown, fallback = ''): string {
  if (v === null || v === undefined) return fallback;
  return String(v);
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Verify X-Webhook-Signature against the raw request body. */
export function verifyGraviaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | null | undefined,
  secret: string
): boolean {
  if (!secret || !signatureHeader) return false;
  // ASCII-only signatures per Gravia docs
  for (let i = 0; i < signatureHeader.length; i++) {
    if (signatureHeader.charCodeAt(i) > 127) return false;
  }

  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected =
    'sha256=' +
    createHmac('sha256', secret).update(body).digest('hex');

  try {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function isGraviaTestEvent(event: string | undefined): boolean {
  return Boolean(event && event.endsWith('_test'));
}

export function isGraviaTradeEvent(event: string | undefined): boolean {
  return event === 'trader_new_trade' || event === 'trader_new_trade_test';
}

/**
 * Map a Gravia trader_new_trade data payload to the bot's activity document shape.
 */
export function mapGraviaTradeToActivity(
  data: Record<string, unknown>,
  deliveryId?: string
): NormalizedGraviaActivity | null {
  const trader = str(data.trader || data.user_address || data.proxy_wallet).toLowerCase();
  const asset = str(data.position_id ?? data.token_id ?? data.asset);
  const conditionId = str(data.condition_id ?? data.conditionId);
  const hash = str(data.hash ?? data.transaction_hash ?? data.trade_id ?? data.tx_hash);
  if (!trader || !asset || !hash) return null;

  const sideRaw = str(data.side, 'BUY').toUpperCase();
  const side = sideRaw === 'SELL' ? 'SELL' : 'BUY';

  // confirmed_at is Unix seconds; envelope timestamp is ms — prefer confirmed_at
  let timestamp = num(data.confirmed_at);
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000);
  if (timestamp <= 0) {
    const ms = num(data.timestamp);
    timestamp = ms > 1e12 ? Math.floor(ms / 1000) : ms || Math.floor(Date.now() / 1000);
  }

  const price = num(data.price);
  const usdcSize = num(data.amount_usd ?? data.usdc_size ?? data.usdcSize);
  const shares = num(data.shares_amount ?? data.size);
  const size = shares > 0 ? shares : price > 0 ? usdcSize / price : 0;

  const traderInfo =
    data.trader_info && typeof data.trader_info === 'object'
      ? (data.trader_info as Record<string, unknown>)
      : {};

  return {
    proxyWallet: trader,
    timestamp,
    conditionId,
    type: 'TRADE',
    size,
    usdcSize,
    transactionHash: hash,
    price,
    asset,
    side,
    outcomeIndex: num(data.outcome_index ?? data.outcomeIndex ?? data.position_outcome_index),
    title: str(data.title ?? data.market_title),
    slug: str(data.slug ?? data.market_slug),
    icon: str(data.image_url ?? data.icon),
    eventSlug: str(data.event_slug ?? data.eventSlug),
    outcome: str(data.outcome),
    name: str(traderInfo.name ?? data.name),
    pseudonym: str(traderInfo.pseudonym ?? data.pseudonym),
    bio: str(traderInfo.bio ?? data.bio),
    profileImage: str(traderInfo.profile_image ?? data.profile_image),
    profileImageOptimized: str(
      traderInfo.profile_image_optimized ?? data.profile_image_optimized
    ),
    bot: false,
    botExcutedTime: 0,
    source: 'gravia',
    graviaDeliveryId: deliveryId,
  };
}
