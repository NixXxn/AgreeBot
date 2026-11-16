import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';

export const dynamic = 'force-dynamic';

const COLLECTION = 'auto_claim_state';
const DOC_ID = 'default';

export type AutoClaimHistoryEntryDto = {
  at: string;
  amountUsd: number;
  recipient: string;
  txHash?: string;
  txId?: string;
  baselineBefore: number;
  baselineAfter: number;
  cashBefore: number;
};

export type AutoClaimStatusResponse = {
  enabled: boolean;
  baseline: number;
  lastCheckAt: string | null;
  lastPayoutUsd: number | null;
  lastRecipient: string | null;
  history: AutoClaimHistoryEntryDto[];
};

type AutoClaimDoc = {
  _id: string;
  baseline?: number;
  lastCheckAt?: Date | string;
  lastPayoutUsd?: number;
  lastRecipient?: string;
  lastTxId?: string;
  updatedAt?: Date | string;
  history?: Array<{
    at?: Date | string;
    amountUsd?: number;
    recipient?: string;
    txHash?: string;
    txId?: string;
    baselineBefore?: number;
    baselineAfter?: number;
    cashBefore?: number;
  }>;
};

function asIso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function GET() {
  try {
    const db = await getDb();
    if (!db) {
      return NextResponse.json(
        { error: 'MongoDB not available' },
        { status: 503 }
      );
    }

    const doc = await db
      .collection<AutoClaimDoc>(COLLECTION)
      .findOne({ _id: DOC_ID });
    const enabled = process.env.AUTO_CLAIM_ENABLED !== 'false';

    const history: AutoClaimHistoryEntryDto[] = [];
    for (const entry of doc?.history || []) {
      const at = asIso(entry.at);
      const amountUsd = Number(entry.amountUsd);
      if (!at || !Number.isFinite(amountUsd)) continue;
      history.push({
        at,
        amountUsd,
        recipient: String(entry.recipient || ''),
        txHash: entry.txHash ? String(entry.txHash) : undefined,
        txId: entry.txId ? String(entry.txId) : undefined,
        baselineBefore: Number(entry.baselineBefore) || 0,
        baselineAfter: Number(entry.baselineAfter) || 0,
        cashBefore: Number(entry.cashBefore) || 0,
      });
    }

    // Bootstrap one history row from legacy last-payout fields if needed
    if (
      history.length === 0 &&
      doc &&
      typeof doc.lastPayoutUsd === 'number' &&
      doc.lastPayoutUsd > 0
    ) {
      const at = asIso(doc.updatedAt) || new Date().toISOString();
      const txRef = doc.lastTxId ? String(doc.lastTxId) : undefined;
      const looksLikeHash = Boolean(txRef?.startsWith('0x') && txRef.length >= 66);
      history.push({
        at,
        amountUsd: doc.lastPayoutUsd,
        recipient: doc.lastRecipient ? String(doc.lastRecipient) : '',
        txHash: looksLikeHash ? txRef : undefined,
        txId: !looksLikeHash ? txRef : undefined,
        baselineBefore: 0,
        baselineAfter: typeof doc.baseline === 'number' ? doc.baseline : 0,
        cashBefore: 0,
      });
    }

    const body: AutoClaimStatusResponse = {
      enabled,
      baseline: typeof doc?.baseline === 'number' ? doc.baseline : 0,
      lastCheckAt: asIso(doc?.lastCheckAt),
      lastPayoutUsd:
        typeof doc?.lastPayoutUsd === 'number' ? doc.lastPayoutUsd : null,
      lastRecipient: doc?.lastRecipient ? String(doc.lastRecipient) : null,
      history,
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error('Auto claim status error:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load auto-claim history',
      },
      { status: 500 }
    );
  }
}
