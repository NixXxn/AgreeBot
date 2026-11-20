import { getDb } from './mongo';
import { stripQuotes } from './env';
import { parseTraderListInput } from './traders';

export { normalizeTraderAddresses, parseTraderListInput } from './traders';

const COLLECTION = 'runtime_settings';
const DOC_ID = 'overrides';

type RuntimeDoc = {
  _id: string;
  values?: Record<string, string>;
  /** @deprecated Legacy Coolify sync fingerprint — no longer written. */
  coolifyUserAddressesFp?: string;
  updatedAt?: Date;
};

export async function getRuntimeOverrides(options?: {
  /** When true, Mongo read failures throw instead of returning {}. */
  required?: boolean;
}): Promise<Record<string, string>> {
  const required = options?.required === true;
  const db = await getDb();
  if (!db) {
    if (required) {
      throw new Error('MongoDB not available — cannot load dashboard settings');
    }
    return {};
  }

  try {
    const doc = await db
      .collection<RuntimeDoc>(COLLECTION)
      .findOne({ _id: DOC_ID });
    if (!doc?.values || typeof doc.values !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(doc.values)) {
      if (v !== undefined && v !== null) out[k] = stripQuotes(String(v));
    }
    return out;
  } catch (error) {
    console.error('Failed to read runtime settings:', error);
    if (required) {
      throw error instanceof Error
        ? error
        : new Error('Failed to read runtime settings from MongoDB');
    }
    return {};
  }
}

/**
 * Merge dashboard overrides into env.
 * USER_ADDRESSES always comes from Mongo only (never Coolify / .env).
 */
export async function getMergedEnv(
  base: Record<string, string>,
  options?: { required?: boolean }
): Promise<Record<string, string>> {
  const { USER_ADDRESSES: _ignoredEnvTraders, ...rest } = base;
  const overrides = await getRuntimeOverrides(options);
  return { ...rest, ...overrides };
}

export async function saveRuntimeOverrides(
  updates: Record<string, string | null>
): Promise<Record<string, string>> {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB not available — cannot persist settings');
  }

  let existing: Record<string, string> = {};
  try {
    existing = await getRuntimeOverrides();
  } catch (error) {
    console.warn('Could not read existing overrides before save:', error);
  }

  const merged = { ...existing };

  for (const [key, value] of Object.entries(updates)) {
    // null = unset override. Empty string = explicit empty.
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = stripQuotes(value);
    }
  }

  const result = await db.collection<RuntimeDoc>(COLLECTION).updateOne(
    { _id: DOC_ID },
    {
      $set: {
        values: merged,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  if (!result.acknowledged) {
    throw new Error('MongoDB did not acknowledge settings write');
  }

  // Read-after-write so races cannot silently drop traders
  const verified = await getRuntimeOverrides({ required: true });
  if (updates.USER_ADDRESSES !== undefined && updates.USER_ADDRESSES !== null) {
    const expected = stripQuotes(updates.USER_ADDRESSES);
    const actual = verified.USER_ADDRESSES ?? '';
    if (actual !== expected) {
      throw new Error(
        'Settings write verification failed — traders not stored in MongoDB'
      );
    }
  }

  return verified;
}

/** Configured traders from Mongo/dashboard only. */
export async function getConfiguredTraderAddresses(): Promise<string[]> {
  try {
    const overrides = await getRuntimeOverrides();
    if (!Object.prototype.hasOwnProperty.call(overrides, 'USER_ADDRESSES')) {
      return [];
    }
    const raw = overrides.USER_ADDRESSES ?? '';
    if (!raw.trim()) return [];
    return parseTraderListInput(raw);
  } catch (error) {
    console.error('Failed to load trader overrides:', error);
    return [];
  }
}
