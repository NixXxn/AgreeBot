export interface CopyTrade {
  timestamp: number;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  conditionId: string;
  asset: string;
  matchedTrader: string | null;
  matchedTraderLabel: string | null;
  timeDiff: number | null;
  /** Wallets that agreed / were copied for this bot entry */
  agreeingTraders?: string[];
  currentPrice?: number | null;
  pnl?: number | null;
  roi?: number | null;
  paper?: boolean;
  resolved?: boolean;
}

export interface TraderCopyStats {
  traderAddress: string;
  traderLabel: string;
  trades: CopyTrade[];
  totalBought: number;
  totalSold: number;
  tradeCount: number;
  pnl: number;
  roi: number;
}

export interface MyTradesResponse {
  myWallet: string;
  analysisDate?: string;
  traders: { address: string; label: string }[];
  allMyTrades: CopyTrade[];
  byTrader: TraderCopyStats[];
  positions?: {
    total: number;
    totalValue: number;
    unrealizedPnL: number;
    realizedPnL: number;
    totalPnL: number;
  };
  summary: {
    totalTrades: number;
    totalBought: number;
    totalSold: number;
    matchedTrades: number;
    unmatchedTrades: number;
  };
  cached?: boolean;
  cacheDate?: string;
  paperMode?: boolean;
  message?: string;
}
