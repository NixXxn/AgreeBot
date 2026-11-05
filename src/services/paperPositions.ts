import { BotSignal } from '../models/botSignal';
import Logger from '../utils/logger';

interface PaperPosition {
    asset: string;
    conditionId: string;
    sizeUsd: number;
    tokens: number;
    avgPrice: number;
    title?: string;
    outcome?: string;
}

/** In-memory paper book keyed by asset (token id). */
const book = new Map<string, PaperPosition>();

/**
 * Rebuild open paper positions from bot_signals (entered BUY − entered SELL).
 */
export const loadPaperPositionsFromDb = async (): Promise<void> => {
    book.clear();
    try {
        const signals = await BotSignal.find({ entered: true, paper: true })
            .sort({ createdAt: 1 })
            .lean()
            .exec();

        for (const s of signals) {
            const asset = String(s.asset || '');
            if (!asset) continue;
            const side = String(s.side || 'BUY').toUpperCase();
            const sizeUsd = Number(s.sizeUsd || 0);
            const price = Number(s.entryPrice || 0);
            if (sizeUsd <= 0 || price <= 0) continue;

            const tokens = sizeUsd / price;
            const existing = book.get(asset);

            if (side === 'BUY') {
                if (!existing) {
                    book.set(asset, {
                        asset,
                        conditionId: String(s.conditionId || ''),
                        sizeUsd,
                        tokens,
                        avgPrice: price,
                        title: s.title,
                        outcome: s.outcome,
                    });
                } else {
                    const newTokens = existing.tokens + tokens;
                    const newSize = existing.sizeUsd + sizeUsd;
                    existing.tokens = newTokens;
                    existing.sizeUsd = newSize;
                    existing.avgPrice = newTokens > 0 ? newSize / newTokens : existing.avgPrice;
                }
            } else if (side === 'SELL' && existing) {
                const sellTokens = Math.min(tokens, existing.tokens);
                const sellUsd = sellTokens * existing.avgPrice;
                existing.tokens = Math.max(0, existing.tokens - sellTokens);
                existing.sizeUsd = Math.max(0, existing.sizeUsd - sellUsd);
                if (existing.tokens < 1e-8) {
                    book.delete(asset);
                }
            }
        }

        Logger.info(`Paper book loaded: ${book.size} open position(s)`);
    } catch (error) {
        Logger.warning(
            `Could not load paper positions: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

export const getPaperPosition = (asset: string): PaperPosition | undefined => {
    return book.get(asset);
};

export const hasOpenPaperPosition = (asset: string): boolean => {
    const pos = book.get(asset);
    return Boolean(pos && pos.tokens > 1e-8);
};

/**
 * Apply a paper fill to the book. Returns tokens/size actually applied.
 */
export const applyPaperFill = (
    side: 'BUY' | 'SELL',
    asset: string,
    conditionId: string,
    sizeUsd: number,
    price: number,
    meta?: { title?: string; outcome?: string }
): { sizeUsd: number; tokens: number } => {
    if (!asset || sizeUsd <= 0 || price <= 0) {
        return { sizeUsd: 0, tokens: 0 };
    }

    const tokens = sizeUsd / price;

    if (side === 'BUY') {
        const existing = book.get(asset);
        if (!existing) {
            book.set(asset, {
                asset,
                conditionId,
                sizeUsd,
                tokens,
                avgPrice: price,
                title: meta?.title,
                outcome: meta?.outcome,
            });
        } else {
            const newTokens = existing.tokens + tokens;
            const newSize = existing.sizeUsd + sizeUsd;
            existing.tokens = newTokens;
            existing.sizeUsd = newSize;
            existing.avgPrice = newTokens > 0 ? newSize / newTokens : price;
        }
        return { sizeUsd, tokens };
    }

    // SELL
    const existing = book.get(asset);
    if (!existing || existing.tokens <= 0) {
        return { sizeUsd: 0, tokens: 0 };
    }

    const sellTokens = Math.min(tokens, existing.tokens);
    const sellUsd = sellTokens * price;
    existing.tokens -= sellTokens;
    existing.sizeUsd = Math.max(0, existing.sizeUsd - sellTokens * existing.avgPrice);
    if (existing.tokens < 1e-8) {
        book.delete(asset);
    }
    return { sizeUsd: sellUsd, tokens: sellTokens };
};
