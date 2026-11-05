import { getDb } from './mongo';

const COLLECTION = 'runtime_settings';
const DOC_ID = 'overrides';

export async function getRuntimeOverrides(): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) return {};

  try {
    type RuntimeDoc = { _id: string; values?: Record<string, string> };
    const doc = await db
      .collection<RuntimeDoc>(COLLECTION)
      .findOne({ _id: DOC_ID });
    if (!doc?.values || typeof doc.values !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc.values)) {
      if (v !== undefined && v !== null) out[k] = String(v);
    }
    return out;
  } catch (error) {
    console.error('Failed to read runtime settings:', error);
    return {};
  }
}

export async function saveRuntimeOverrides(
  updates: Record<string, string | null>
): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB not available — cannot persist settings');
  }

  const existing = await getRuntimeOverrides();
  const merged = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === '') {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }

  type RuntimeDoc = { _id: string; values?: Record<string, string>; updatedAt?: Date };
  await db.collection<RuntimeDoc>(COLLECTION).updateOne(
    { _id: DOC_ID },
    {
      $set: {
        values: merged,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  return merged;
}
