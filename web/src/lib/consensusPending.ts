import { getDb } from './mongo';

export type PendingConsensusGroup = {
  id: string;
  conditionId: string;
  asset: string;
  side: string;
  outcome?: string;
  title?: string;
  slug?: string;
  traders: number;
  required: number;
  agreeingTraders: string[];
  firstTradeAt: number;
  ageSeconds: number;
  windowSeconds: number;
  updatedAt?: string;
};

/**
 * Open consensus groups mirrored by the bot into Mongo (`consensus_pending`).
 */
export async function listPendingConsensus(
  windowSecondsFallback = 2400
): Promise<PendingConsensusGroup[]> {
  const db = await getDb();
  if (!db) return [];

  try {
    const rows = await db
      .collection('consensus_pending')
      .find({})
      .sort({ updatedAt: -1 })
      .toArray();

    const now = Math.floor(Date.now() / 1000);
    return rows.map((row) => {
      const firstTradeAt =
        typeof row.firstTradeAt === 'number' ? row.firstTradeAt : now;
      return {
        id: String(row._id),
        conditionId: String(row.conditionId || ''),
        asset: String(row.asset || ''),
        side: String(row.side || 'BUY').toUpperCase(),
        outcome: row.outcome ? String(row.outcome) : undefined,
        title: row.title ? String(row.title) : undefined,
        slug: row.slug || row.eventSlug ? String(row.slug || row.eventSlug) : undefined,
        traders: Number(row.traders) || 0,
        required: Number(row.required) || 0,
        agreeingTraders: Array.isArray(row.agreeingTraders)
          ? row.agreeingTraders.map(String)
          : [],
        firstTradeAt,
        ageSeconds: Math.max(0, now - firstTradeAt),
        windowSeconds: windowSecondsFallback,
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : row.updatedAt
              ? String(row.updatedAt)
              : undefined,
      };
    });
  } catch (error) {
    console.error('Failed to list consensus_pending:', error);
    return [];
  }
}
