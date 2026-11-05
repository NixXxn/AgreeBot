import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const reportsDir = path.join(process.cwd(), '..', 'trader_reports');
    const myTradesPath = path.join(reportsDir, '_MY_TRADES.json');

    // Check if cached data exists
    if (fs.existsSync(myTradesPath) && !refresh) {
      const data = JSON.parse(fs.readFileSync(myTradesPath, 'utf-8'));
      return NextResponse.json({
        ...data,
        cached: true,
        cacheDate: data.analysisDate,
      });
    }

    // If no cache or refresh requested, fetch live data
    return await fetchLiveData(reportsDir);
  } catch (error) {
    console.error('Error fetching my trades:', error);
    return NextResponse.json(
      { error: 'Failed to fetch my trades' },
      { status: 500 }
    );
  }
}

function getEnvValue(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  try {
    const envPath = path.join(process.cwd(), '..', '.env');
    if (!fs.existsSync(envPath)) return '';
    const match = fs.readFileSync(envPath, 'utf-8').match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
    if (!match) return '';
    let v = match[1].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
      v = v.slice(1, -1);
    }
    return v;
  } catch {
    return '';
  }
}

async function fetchLiveData(reportsDir: string) {
  const summaryPath = path.join(reportsDir, '_SUMMARY.json');
  const paperMode =
    getEnvValue('PAPER_MODE') === 'true' || getEnvValue('PREVIEW_MODE') === 'true';
  const proxyWallet = getEnvValue('PROXY_WALLET');

  // Paper mode / no wallet: return an empty but valid payload (no analyze required)
  if (!fs.existsSync(summaryPath) && (paperMode || !proxyWallet)) {
    return NextResponse.json({
      analysisDate: new Date().toISOString(),
      myWallet: proxyWallet || null,
      paperMode: true,
      summary: {
        totalCopiedTrades: 0,
        copyBuyCount: 0,
        copySellCount: 0,
        totalCopyVolume: 0,
        matchedBuyVolume: 0,
        matchedSellVolume: 0,
        estimatedCopyPnL: 0,
        positionsPnL: 0,
      },
      byTrader: [],
      trades: [],
      message: paperMode
        ? 'Paper mode — no live copy trades yet. Signals appear in bot logs as [PAPER] Would …'
        : 'No PROXY_WALLET configured. Set a wallet or run npm run analyze for historical reports.',
    });
  }

  if (!fs.existsSync(summaryPath)) {
    return NextResponse.json(
      {
        error:
          'No trade reports yet. In paper mode this tab stays empty until you go live, or run npm run analyze locally.',
      },
      { status: 404 }
    );
  }

  const summaryData = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

  const formatWalletLabel = (address: string): string => `0x...${address.slice(-4)}`;

  // Find my wallet
  const myWalletData = summaryData.find((t: { label: string }) =>
    t.label.includes('МОЙ') || t.label.includes('MY') || t.label.includes('My Wallet')
  ) || summaryData[0];

  const myWallet = myWalletData?.address;

  if (!myWallet) {
    return NextResponse.json(
      { error: 'Could not determine my wallet address' },
      { status: 400 }
    );
  }

  // Get trader addresses - use proper wallet format if label is like "Trader X"
  const traders = summaryData
    .filter((t: { address: string }) => t.address.toLowerCase() !== myWallet.toLowerCase())
    .map((t: { address: string; label: string }) => ({
      address: t.address,
      label: t.label.startsWith('Trader ') ? formatWalletLabel(t.address) : t.label,
    }));

  // Fetch ALL my trades and positions
  const [myTrades, myPositions] = await Promise.all([
    fetchTrades(myWallet),
    fetchPositions(myWallet),
  ]);

  // Calculate real P&L from positions
  const totalUnrealizedPnL = myPositions.reduce((sum, p) => sum + (p.cashPnl || 0), 0);
  const totalRealizedPnL = myPositions.reduce((sum, p) => sum + (p.realizedPnl || 0), 0);
  const totalPositionsPnL = totalUnrealizedPnL + totalRealizedPnL;

  // Fetch ALL traders' trades
  const traderTradesMap = new Map<string, Trade[]>();
  for (const trader of traders) {
    const trades = await fetchTrades(trader.address);
    traderTradesMap.set(trader.address.toLowerCase(), trades);
  }

  // Match trades
  const MATCH_WINDOW_SECONDS = 300;

  const allMyTrades = myTrades.map(myTrade => {
    let matchedTrader: string | null = null;
    let matchedTraderLabel: string | null = null;
    let timeDiff: number | null = null;

    for (const trader of traders) {
      const traderTrades = traderTradesMap.get(trader.address.toLowerCase()) || [];
      const match = traderTrades.find(tt =>
        tt.conditionId === myTrade.conditionId &&
        tt.side === myTrade.side &&
        tt.timestamp < myTrade.timestamp &&
        myTrade.timestamp - tt.timestamp <= MATCH_WINDOW_SECONDS
      );

      if (match) {
        matchedTrader = trader.address;
        matchedTraderLabel = trader.label;
        timeDiff = myTrade.timestamp - match.timestamp;
        break;
      }
    }

    return { ...myTrade, matchedTrader, matchedTraderLabel, timeDiff };
  });

  // Group by trader
  const byTraderMap = new Map<string, typeof allMyTrades>();
  byTraderMap.set('unmatched', []);
  for (const trader of traders) {
    byTraderMap.set(trader.address.toLowerCase(), []);
  }

  for (const trade of allMyTrades) {
    if (trade.matchedTrader) {
      const key = trade.matchedTrader.toLowerCase();
      const existing = byTraderMap.get(key) || [];
      existing.push(trade);
      byTraderMap.set(key, existing);
    } else {
      const unmatched = byTraderMap.get('unmatched') || [];
      unmatched.push(trade);
      byTraderMap.set('unmatched', unmatched);
    }
  }

  // Calculate stats
  const byTrader = traders.map((trader: { address: string; label: string }) => {
    const trades = byTraderMap.get(trader.address.toLowerCase()) || [];
    let totalBought = 0;
    let totalSold = 0;

    for (const trade of trades) {
      if (trade.side === 'BUY') totalBought += trade.usdcSize;
      else totalSold += trade.usdcSize;
    }

    return {
      traderAddress: trader.address,
      traderLabel: trader.label,
      trades,
      totalBought,
      totalSold,
      tradeCount: trades.length,
      pnl: totalSold - totalBought,
      roi: totalBought > 0 ? ((totalSold - totalBought) / totalBought) * 100 : 0,
    };
  });

  // Add unmatched
  const unmatchedTrades = byTraderMap.get('unmatched') || [];
  if (unmatchedTrades.length > 0) {
    let totalBought = 0;
    let totalSold = 0;
    for (const trade of unmatchedTrades) {
      if (trade.side === 'BUY') totalBought += trade.usdcSize;
      else totalSold += trade.usdcSize;
    }
    byTrader.push({
      traderAddress: 'unmatched',
      traderLabel: 'Unmatched Trades',
      trades: unmatchedTrades,
      totalBought,
      totalSold,
      tradeCount: unmatchedTrades.length,
      pnl: totalSold - totalBought,
      roi: totalBought > 0 ? ((totalSold - totalBought) / totalBought) * 100 : 0,
    });
  }

  byTrader.sort((a: { tradeCount: number }, b: { tradeCount: number }) => b.tradeCount - a.tradeCount);

  const matchedCount = allMyTrades.filter(t => t.matchedTrader).length;

  const result = {
    myWallet,
    analysisDate: new Date().toISOString(),
    traders,
    allMyTrades,
    byTrader,
    positions: {
      total: myPositions.length,
      totalValue: myPositions.reduce((s, p) => s + (p.currentValue || 0), 0),
      unrealizedPnL: totalUnrealizedPnL,
      realizedPnL: totalRealizedPnL,
      totalPnL: totalPositionsPnL,
    },
    summary: {
      totalTrades: allMyTrades.length,
      totalBought: allMyTrades.filter(t => t.side === 'BUY').reduce((s, t) => s + t.usdcSize, 0),
      totalSold: allMyTrades.filter(t => t.side === 'SELL').reduce((s, t) => s + t.usdcSize, 0),
      matchedTrades: matchedCount,
      unmatchedTrades: allMyTrades.length - matchedCount,
    },
    cached: false,
  };

  // Save to cache
  const myTradesPath = path.join(reportsDir, '_MY_TRADES.json');
  fs.writeFileSync(myTradesPath, JSON.stringify(result, null, 2));

  return NextResponse.json(result);
}

interface Trade {
  timestamp: number;
  side: 'BUY' | 'SELL';
  usdcSize: number;
  price: number;
  title: string;
  outcome: string;
  conditionId: string;
  asset: string;
}

interface Position {
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  realizedPnl: number;
  curPrice: number;
  title: string;
  outcome: string;
}

function unwrapData(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

async function fetchPositions(address: string): Promise<Position[]> {
  const url = `https://data-api.polymarket.com/v2/positions?user=${address}&limit=500`;
  const response = await fetch(url);
  const payload = await response.json();
  return unwrapData(payload).map((row) => ({
    asset: String(row.token_id ?? row.asset ?? ''),
    conditionId: String(row.condition_id ?? row.conditionId ?? ''),
    size: Number(row.current_size ?? row.size ?? 0),
    avgPrice: Number(row.avg_price ?? row.avgPrice ?? 0),
    initialValue: Number(row.entry_cost_usdc ?? row.initialValue ?? 0),
    currentValue: Number(row.current_value ?? row.currentValue ?? 0),
    cashPnl: Number(row.unrealized_pnl ?? row.cashPnl ?? 0),
    percentPnl: Number(row.percent_pnl ?? row.percentPnl ?? 0),
    realizedPnl: Number(row.realized_pnl ?? row.realizedPnl ?? 0),
    curPrice: Number(row.current_price ?? row.curPrice ?? 0),
    title: String(row.title ?? ''),
    outcome: String(row.outcome ?? ''),
  }));
}

async function fetchTrades(address: string): Promise<Trade[]> {
  const allTrades: Trade[] = [];
  let cursor: string | null = null;
  const limit = 200;

  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({
      user: address,
      type: 'TRADE',
      limit: String(limit),
    });
    if (cursor) params.set('cursor', cursor);

    const url = `https://data-api.polymarket.com/v2/activity?${params.toString()}`;
    const response = await fetch(url);
    const payload = await response.json();
    const rows = unwrapData(payload);

    if (rows.length === 0) break;

    for (const row of rows) {
      allTrades.push({
        timestamp: Number(row.timestamp ?? 0),
        side: String(row.side ?? ''),
        usdcSize: Number(row.usdc_size ?? row.usdcSize ?? 0),
        size: Number(row.size ?? 0),
        price: Number(row.price ?? 0),
        title: String(row.title ?? ''),
        outcome: String(row.outcome ?? ''),
        conditionId: String(row.condition_id ?? row.conditionId ?? ''),
        asset: String(row.token_id ?? row.asset ?? ''),
      });
    }

    const next =
      payload && typeof payload === 'object'
        ? (payload as { pagination?: { next_cursor?: string | null; has_more?: boolean } })
            .pagination
        : undefined;
    if (!next?.has_more || !next.next_cursor) break;
    cursor = next.next_cursor;
  }

  return allTrades;
}
