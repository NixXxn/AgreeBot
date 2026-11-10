export interface BotTradeRow {
  id: string;
  createdAt: number;
  conditionId: string;
  asset: string;
  side: 'BUY' | 'SELL';
  title: string;
  slug: string;
  outcome: string;
  entryPrice: number;
  currentPrice: number | null;
  sizeUsd: number;
  agreementCount: number;
  agreeingTraders: string[];
  entered: boolean;
  paper: boolean;
  reason: string;
  minAgreement: number | null;
  pnl: number | null;
  roi: number | null;
  resolved?: boolean;
}

export interface TradesResponse {
  trades: BotTradeRow[];
  summary?: {
    total: number;
    entered: number;
    skipped: number;
    totalPnl: number;
    paper: boolean;
    resolved?: number;
    limit?: number;
  };
  paperMode?: boolean;
  error?: string;
  fetchedAt?: string;
}
