import { MongoClient, Db } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';
import { stripQuotes } from './env';

const ENV_PATH = path.join(process.cwd(), '..', '.env');

function getEnvValue(key: string): string {
  if (process.env[key]) return stripQuotes(process.env[key] as string);
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!match) return '';
    return stripQuotes(match[1]);
  } catch {
    return '';
  }
}

/** Database name from URI path (mongoose-compatible). */
export function getMongoDbName(uri: string): string | undefined {
  try {
    const normalized = uri.replace(/^mongodb\+srv:/i, 'https:').replace(/^mongodb:/i, 'http:');
    const pathname = new URL(normalized).pathname.replace(/^\//, '');
    const name = decodeURIComponent(pathname.split('/')[0] || '');
    return name || undefined;
  } catch {
    return undefined;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __agreebotMongo: { client: MongoClient; db: Db; uri: string } | undefined;
}

export async function getDb(): Promise<Db | null> {
  const uri = getEnvValue('MONGO_URI');
  if (!uri) return null;

  if (global.__agreebotMongo?.client && global.__agreebotMongo.uri === uri) {
    return global.__agreebotMongo.db;
  }

  // Drop stale cached client if URI changed
  if (global.__agreebotMongo?.client) {
    try {
      await global.__agreebotMongo.client.close();
    } catch {
      /* ignore */
    }
    global.__agreebotMongo = undefined;
  }

  const client = new MongoClient(uri);
  await client.connect();
  const dbName = getMongoDbName(uri);
  const db = dbName ? client.db(dbName) : client.db();
  global.__agreebotMongo = { client, db, uri };
  return db;
}

export function getUserAddressesFromEnv(): string[] {
  const raw = getEnvValue('USER_ADDRESSES');
  if (!raw) return [];
  if (raw.trim().startsWith('[')) {
    try {
      return (JSON.parse(raw) as string[])
        .map((s) => stripQuotes(String(s)).toLowerCase().trim())
        .filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return raw
    .split(',')
    .map((s) => stripQuotes(s).toLowerCase().trim())
    .filter(Boolean);
}
