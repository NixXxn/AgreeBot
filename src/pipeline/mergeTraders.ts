const ADDR_RE = /^0x[a-f0-9]{40}$/;

export function normalizeAddress(address: string): string | null {
    const a = address.trim().toLowerCase();
    return ADDR_RE.test(a) ? a : null;
}

export function parseAddressList(input: string | string[] | undefined | null): string[] {
    if (!input) return [];
    const tokens = Array.isArray(input)
        ? input
        : input.split(/[\s,]+/).map((s) => s.trim());
    const out: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
        const a = normalizeAddress(token);
        if (!a || seen.has(a)) continue;
        seen.add(a);
        out.push(a);
    }
    return out;
}

/**
 * Merge pipeline traders into the dashboard list without wiping manual wallets.
 *
 * - Keep every current address that is NOT in the previous pipeline-applied set
 *   (those are treated as user-managed).
 * - Drop previous pipeline addresses that are no longer in the new curated set.
 * - Append / refresh the new pipeline set.
 */
export function mergeTraderLists(input: {
    current: string[];
    previousPipeline: string[];
    nextPipeline: string[];
}): { merged: string[]; added: string[]; removedPipeline: string[]; keptManual: string[] } {
    const current = parseAddressList(input.current);
    const previousPipeline = new Set(parseAddressList(input.previousPipeline));
    const nextPipeline = parseAddressList(input.nextPipeline);
    const nextSet = new Set(nextPipeline);

    const keptManual = current.filter((a) => !previousPipeline.has(a));
    const removedPipeline = [...previousPipeline].filter((a) => !nextSet.has(a));

    const merged: string[] = [];
    const seen = new Set<string>();
    for (const a of [...keptManual, ...nextPipeline]) {
        if (seen.has(a)) continue;
        seen.add(a);
        merged.push(a);
    }

    const before = new Set(current);
    const added = nextPipeline.filter((a) => !before.has(a));

    return { merged, added, removedPipeline, keptManual };
}
