import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import {
  getConfiguredTraderAddresses,
  normalizeTraderAddresses,
} from '@/lib/runtimeSettings';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

async function walletsWithoutFills(candidates: string[]) {
  const configured = normalizeTraderAddresses(candidates);
  if (configured.length === 0) {
    return {
      withoutFills: [] as string[],
      withFills: [] as string[],
      total: 0,
      withoutFillsCount: 0,
    };
  }

  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB not configured');
  }

  const raw = await db.collection('bot_signals').distinct('agreeingTraders', {
    entered: true,
  });
  const withFillsSet = new Set(
    (Array.isArray(raw) ? raw : [])
      .map((a) => String(a || '').toLowerCase())
      .filter((a) => /^0x[a-f0-9]{40}$/.test(a))
  );

  const withoutFills: string[] = [];
  const withFills: string[] = [];
  for (const addr of configured) {
    const key = addr.toLowerCase();
    if (withFillsSet.has(key)) withFills.push(addr);
    else withoutFills.push(addr);
  }

  return {
    withoutFills,
    withFills,
    total: configured.length,
    withoutFillsCount: withoutFills.length,
  };
}

/** Uses the saved Mongo trader list. */
export async function GET() {
  try {
    const configured = await getConfiguredTraderAddresses();
    const result = await walletsWithoutFills(configured);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to list wallets without fills:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to list wallets without fills',
      },
      { status: 500 }
    );
  }
}

/** Prefer this from Settings so unsaved local list is respected. */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { traders?: string[] };
    const traders = Array.isArray(body.traders)
      ? body.traders
      : await getConfiguredTraderAddresses();
    const result = await walletsWithoutFills(traders);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Failed to list wallets without fills:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to list wallets without fills',
      },
      { status: 500 }
    );
  }
}
