import * as fs from 'fs';
import * as path from 'path';

const ENV_PATH = path.join(process.cwd(), '..', '.env');

/** Strip Coolify/copy-paste wrapping quotes from env values. */
export function stripQuotes(value: string): string {
  let v = value.trim();
  // Peel nested wrapping quotes: "'https://...'" or ''https://...''
  for (let i = 0; i < 3; i++) {
    if (
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))
    ) {
      v = v.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return v;
}

export function readEnvFileValue(key: string): string | undefined {
  try {
    if (!fs.existsSync(ENV_PATH)) return undefined;
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) continue;
      if (trimmed.slice(0, equalIndex).trim() !== key) continue;
      return stripQuotes(trimmed.slice(equalIndex + 1));
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Join base + path safely (handles missing/extra slashes and quoted bases). */
export function joinUrl(base: string, pathPart: string): string {
  const cleaned = stripQuotes(base || '').replace(/\/+$/, '');
  const pathClean = pathPart.replace(/^\/+/, '');
  return `${cleaned}/${pathClean}`;
}
