import { MongoClient, Db } from 'mongodb';
import * as fs from 'fs';
import * as path from 'path';

const ENV_PATH = path.join(process.cwd(), '..', '.env');

function getEnvValue(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  try {
    if (!fs.existsSync(ENV_PATH)) return '';
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const match = content.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!match) return '';
    let v = match[1].trim();
    if (
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  } catch {
    return '';
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __agreebotMongo: { client: MongoClient; db: Db } | undefined;
}

export async function getDb(): Promise<Db | null> {
  const uri = getEnvValue('MONGO_URI');
  if (!uri) return null;

  if (global.__agreebotMongo?.client) {
    return global.__agreebotMongo.db;
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  global.__agreebotMongo = { client, db };
  return db;
}

export function getUserAddresses(): string[] {
  const raw = getEnvValue('USER_ADDRESSES');
  if (!raw) return [];
  if (raw.trim().startsWith('[')) {
    try {
      return (JSON.parse(raw) as string[]).map((s) => s.trim()).filter(Boolean);
    } catch {
      /* fall through */
    }
  }
  return raw
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}
