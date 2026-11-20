const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function stripQuotes(value: string): string {
  let v = value.trim();
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

/**
 * Parse a pasted trader list: comma-separated, whitespace/newlines, or JSON array.
 */
export function parseTraderListInput(raw: string): string[] {
  const trimmed = stripQuotes(raw || '');
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      return normalizeTraderAddresses(JSON.parse(trimmed) as string[]);
    } catch {
      /* fall through */
    }
  }
  return normalizeTraderAddresses(trimmed.split(/[\s,;]+/).filter(Boolean));
}
