import type { CopyTrade, TraderCopyStats } from '@/types/myTrades';

/**
 * Exit proceeds in USDC.
 * Live SELLs use the trade size. Resolved paper BUYs have no SELL row — settle at
 * entry size + mark-to-market P/L (winners → size+pnl, losers → ~0).
 */
export function tradeExitProceeds(trade: CopyTrade): number {
  if (trade.side === 'SELL') return Number(trade.usdcSize || 0);
  if (trade.resolved && trade.pnl != null && Number.isFinite(trade.pnl)) {
    return Math.max(0, Number(trade.usdcSize || 0) + Number(trade.pnl));
  }
  return 0;
}

export function summarizeCopyTrades(
  trades: CopyTrade[],
  options?: { paperMode?: boolean; share?: number }
): Pick<TraderCopyStats, 'totalBought' | 'totalSold' | 'tradeCount' | 'pnl' | 'roi'> {
  const share = options?.share ?? 1;
  const paperMode = Boolean(options?.paperMode);
  let totalBought = 0;
  let totalSold = 0;
  let pnl = 0;
  let hasMarkedPnl = false;

  for (const trade of trades) {
    const size = Number(trade.usdcSize || 0) * share;
    if (trade.side === 'BUY') {
      totalBought += size;
      // Resolved paper BUY settles without a separate SELL signal
      totalSold += tradeExitProceeds(trade) * share;
    } else {
      totalSold += size;
    }

    if (trade.pnl != null && Number.isFinite(trade.pnl)) {
      pnl += Number(trade.pnl) * share;
      hasMarkedPnl = true;
    }
  }

  // Live wallet history: cashflow is authoritative. Paper: use mark-to-market P/L.
  if (!paperMode || !hasMarkedPnl) {
    pnl = totalSold - totalBought;
  }

  return {
    totalBought,
    totalSold,
    tradeCount: trades.length,
    pnl,
    roi: totalBought > 0 ? (pnl / totalBought) * 100 : 0,
  };
}

/** Wallets this trade should count toward (all agreeing, else matched, else unmatched). */
export function walletsForTrade(trade: CopyTrade): string[] {
  if (trade.agreeingTraders && trade.agreeingTraders.length > 0) {
    return trade.agreeingTraders.map((w) => w.toLowerCase());
  }
  if (trade.matchedTrader) return [trade.matchedTrader.toLowerCase()];
  return ['unmatched'];
}

export function buildByTraderStats(
  trades: CopyTrade[],
  traders: { address: string; label: string }[],
  options?: { paperMode?: boolean }
): TraderCopyStats[] {
  const paperMode = Boolean(options?.paperMode);
  const byTraderMap = new Map<string, CopyTrade[]>();
  byTraderMap.set('unmatched', []);
  for (const trader of traders) {
    byTraderMap.set(trader.address.toLowerCase(), []);
  }

  for (const trade of trades) {
    const wallets = walletsForTrade(trade);
    for (const key of wallets) {
      const list = byTraderMap.get(key) || [];
      list.push(trade);
      byTraderMap.set(key, list);
    }
  }

  const rows: TraderCopyStats[] = traders.map((trader) => {
    const list = byTraderMap.get(trader.address.toLowerCase()) || [];
    // Proportional attribution when a trade is shared across agreeing wallets
    const stats = list.reduce(
      (acc, trade) => {
        const n = Math.max(walletsForTrade(trade).length, 1);
        const part = summarizeCopyTrades([trade], { paperMode, share: 1 / n });
        return {
          totalBought: acc.totalBought + part.totalBought,
          totalSold: acc.totalSold + part.totalSold,
          pnl: acc.pnl + part.pnl,
        };
      },
      { totalBought: 0, totalSold: 0, pnl: 0 }
    );

    return {
      traderAddress: trader.address,
      traderLabel: trader.label,
      trades: list,
      tradeCount: list.length,
      totalBought: stats.totalBought,
      totalSold: stats.totalSold,
      pnl: stats.pnl,
      roi: stats.totalBought > 0 ? (stats.pnl / stats.totalBought) * 100 : 0,
    };
  });

  const unmatched = byTraderMap.get('unmatched') || [];
  if (unmatched.length > 0) {
    const stats = summarizeCopyTrades(unmatched, { paperMode });
    rows.push({
      traderAddress: 'unmatched',
      traderLabel: 'Unmatched Trades',
      trades: unmatched,
      ...stats,
    });
  }

  return rows.sort((a, b) => b.tradeCount - a.tradeCount);
}
