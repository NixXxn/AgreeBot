import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { getConfiguredTraderAddresses } from '@/lib/runtimeSettings';
import { getGraviaConfig } from '@/lib/graviaClient';
import {
  isGraviaTestEvent,
  isGraviaTradeEvent,
  mapGraviaTradeToActivity,
  verifyGraviaSignature,
  type GraviaWebhookEnvelope,
} from '@/lib/graviaWebhook';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DELIVERY_COLLECTION = 'gravia_webhook_deliveries';
const DELIVERY_TTL_SECONDS = 7 * 24 * 3600;

type DeliveryDoc = {
  _id: string;
  createdAt: Date;
  transactionHash?: string;
  wallet?: string;
};

async function ensureDeliveryTtlIndex(): Promise<void> {
  const db = await getDb();
  if (!db) return;
  try {
    await db.collection(DELIVERY_COLLECTION).createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: DELIVERY_TTL_SECONDS }
    );
  } catch {
    /* index may already exist */
  }
}

export async function POST(request: Request) {
  const cfg = getGraviaConfig();
  if (!cfg.feedEnabled) {
    return NextResponse.json({ ok: false, error: 'Gravia feed disabled' }, { status: 503 });
  }
  if (!cfg.signingSecret) {
    console.error('[gravia] GRAVIA_SIGNING_SECRET missing');
    return NextResponse.json({ ok: false, error: 'Webhook not configured' }, { status: 503 });
  }

  const rawBody = Buffer.from(await request.arrayBuffer());
  const signature = request.headers.get('x-webhook-signature');

  if (!verifyGraviaSignature(rawBody, signature, cfg.signingSecret)) {
    return NextResponse.json({ ok: false, error: 'Invalid signature' }, { status: 401 });
  }

  let envelope: GraviaWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody.toString('utf8')) as GraviaWebhookEnvelope;
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 });
  }

  const event = envelope.event || '';
  if (!isGraviaTradeEvent(event)) {
    // Ack unknown events so Gravia does not disable the subscription
    return NextResponse.json({ ok: true, ignored: true, event });
  }

  // Synthetic tests: ack only — never insert into the trade pipeline
  if (isGraviaTestEvent(event)) {
    console.log(
      `[gravia] test callback ok delivery=${envelope.id || '?'} webhook=${envelope.webhook_id || '?'}`
    );
    return NextResponse.json({ ok: true, test: true });
  }

  const deliveryId = envelope.id || '';
  const db = await getDb();
  if (!db) {
    return NextResponse.json({ ok: false, error: 'MongoDB unavailable' }, { status: 503 });
  }

  await ensureDeliveryTtlIndex();

  if (deliveryId) {
    const existing = await db
      .collection<DeliveryDoc>(DELIVERY_COLLECTION)
      .findOne({ _id: deliveryId });
    if (existing) {
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  const data =
    envelope.data && typeof envelope.data === 'object' ? envelope.data : null;
  if (!data) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'empty data' });
  }

  const activity = mapGraviaTradeToActivity(data, deliveryId || undefined);
  if (!activity) {
    return NextResponse.json({ ok: true, ignored: true, reason: 'unmappable payload' });
  }

  const traders = await getConfiguredTraderAddresses();
  const watched = new Set(traders.map((t) => t.toLowerCase()));
  if (!watched.has(activity.proxyWallet)) {
    // Not in dashboard list — ack to avoid retry storms
    return NextResponse.json({ ok: true, ignored: true, reason: 'unknown wallet' });
  }

  const collectionName = `user_activities_${activity.proxyWallet}`;
  const col = db.collection(collectionName);

  const existingTrade = await col.findOne({
    transactionHash: activity.transactionHash,
  });
  if (existingTrade) {
    if (deliveryId) {
      await db.collection<DeliveryDoc>(DELIVERY_COLLECTION).updateOne(
        { _id: deliveryId },
        { $set: { createdAt: new Date(), transactionHash: activity.transactionHash } },
        { upsert: true }
      );
    }
    return NextResponse.json({ ok: true, duplicate: true, source: 'tx' });
  }

  const { graviaDeliveryId, ...doc } = activity;
  await col.insertOne({
    ...doc,
    graviaDeliveryId,
    createdAt: new Date(),
  });

  if (deliveryId) {
    await db.collection<DeliveryDoc>(DELIVERY_COLLECTION).updateOne(
      { _id: deliveryId },
      {
        $set: {
          createdAt: new Date(),
          transactionHash: activity.transactionHash,
          wallet: activity.proxyWallet,
        },
      },
      { upsert: true }
    );
  }

  console.log(
    `[gravia] trade ${activity.side} $${activity.usdcSize.toFixed(2)} ` +
      `${activity.proxyWallet.slice(0, 6)}…${activity.proxyWallet.slice(-4)} ` +
      `tx=${activity.transactionHash.slice(0, 10)}…`
  );

  return NextResponse.json({ ok: true, inserted: true });
}
