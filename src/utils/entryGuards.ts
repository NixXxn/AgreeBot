/**
 * Pre-trade entry guards: opposite side, average-down, event-family, crypto up/down.
 */

export const isCryptoUpDownMarket = (parts: {
    slug?: string;
    eventSlug?: string;
    title?: string;
}): boolean => {
    const blob = `${parts.slug || ''} ${parts.eventSlug || ''} ${parts.title || ''}`.toLowerCase();
    if (!blob.trim()) return false;
    if (blob.includes('up-or-down') || blob.includes('up or down')) return true;
    if (/\b(bitcoin|btc|ethereum|eth|solana|sol|xrp)\b.*\b(up|down)\b/.test(blob)) {
        return true;
    }
    // Polymarket 5-minute crypto strips: "November 17, 4:20AM-4:25AM"
    if (
        /\b(bitcoin|btc|ethereum|eth|solana|sol)\b/.test(blob) &&
        /\d{1,2}:\d{2}\s*(am|pm)/i.test(blob)
    ) {
        return true;
    }
    return false;
};

export const isAverageDown = (
    heldAvgPrice: number,
    askPrice: number,
    epsilon = 1e-6
): boolean => {
    if (!(heldAvgPrice > 0) || !(askPrice > 0)) return false;
    return askPrice + epsilon < heldAvgPrice;
};

export type PositionLike = {
    asset?: string;
    conditionId?: string;
    eventSlug?: string;
    slug?: string;
    size?: number;
    avgPrice?: number;
    currentValue?: number;
    outcome?: string;
};

/** Same event family if eventSlug matches (preferred) or slug prefix before -game/-map. */
export const eventFamilyKey = (p: {
    eventSlug?: string;
    slug?: string;
    conditionId?: string;
}): string => {
    const es = (p.eventSlug || '').trim().toLowerCase();
    if (es) return `event:${es}`;
    const slug = (p.slug || '').trim().toLowerCase();
    if (slug) {
        const base = slug
            .replace(/-game\d+.*$/i, '')
            .replace(/-map\d+.*$/i, '')
            .replace(/-game-\d+.*$/i, '')
            .replace(/-map-\d+.*$/i, '');
        return `slug:${base}`;
    }
    return p.conditionId ? `cond:${p.conditionId}` : '';
};

export const findSameAssetPosition = <T extends PositionLike>(
    positions: T[],
    asset: string
): T | undefined => {
    if (!asset) return undefined;
    return positions.find((p) => p.asset === asset && (p.size || 0) > 1e-8);
};

export const findEventFamilyPosition = <T extends PositionLike>(
    positions: T[],
    trade: { eventSlug?: string; slug?: string; conditionId?: string; asset?: string }
): T | undefined => {
    const key = eventFamilyKey(trade);
    if (!key) return undefined;
    return positions.find((p) => {
        if ((p.size || 0) <= 1e-8) return false;
        // Allow adding to the exact same outcome token (handled by average-down guard)
        if (trade.asset && p.asset === trade.asset) return false;
        return eventFamilyKey(p) === key;
    });
};
