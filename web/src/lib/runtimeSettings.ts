import { getDb } from './mongo';
import { stripQuotes } from './env';

const COLLECTION = 'runtime_settings';
const DOC_ID = 'overrides';

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Normalize wallet addresses: strip quotes, lowercase, validate, dedupe. */
export function normalizeTraderAddresses(traders: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of traders) {
    const addr = stripQuotes(String(raw ?? ''))
      .toLowerCase()
      .trim();
    if (!ETH_ADDRESS_RE.test(addr)) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }

  return out;
}

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
    type RuntimeDoc = { _id: string; values?: Record<string, string> };
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
 * Empty-string overrides win (explicit clear) and must not fall back to Coolify.
 */
export async function getMergedEnv(
  base: Record<string, string>,
  options?: { required?: boolean }
): Promise<Record<string, string>> {
  const overrides = await getRuntimeOverrides(options);
  return { ...base, ...overrides };
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
    // null = unset override (fall back to Coolify). Empty string = explicit empty.
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = stripQuotes(value);
    }
  }

  type RuntimeDoc = { _id: string; values?: Record<string, string>; updatedAt?: Date };
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

  // Read-after-write so Coolify/cache races cannot silently drop traders
  const verified = await getRuntimeOverrides({ required: true });
  if (updates.USER_ADDRESSES !== undefined && updates.USER_ADDRESSES !== null) {
    const expected = stripQuotes(updates.USER_ADDRESSES);
    const actual = verified.USER_ADDRESSES ?? '';
    if (actual !== expected) {
      throw new Error(
        'Settings write verification failed — USER_ADDRESSES not stored in MongoDB'
      );
    }
  }

  return verified;
}

/** Configured traders: Mongo overrides win over Coolify / .env. */
export async function getConfiguredTraderAddresses(
  fallbackEnvAddresses: string[]
): Promise<string[]> {
  try {
    const overrides = await getRuntimeOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, 'USER_ADDRESSES')) {
      const raw = overrides.USER_ADDRESSES ?? '';
      if (!raw.trim()) return [];
      if (raw.trim().startsWith('[')) {
        try {
          return normalizeTraderAddresses(JSON.parse(raw) as string[]);
        } catch {
          /* fall through */
        }
      }
      return normalizeTraderAddresses(raw.split(','));
    }
  } catch (error) {
    console.error('Failed to load trader overrides:', error);
  }
  return normalizeTraderAddresses(fallbackEnvAddresses);
}
