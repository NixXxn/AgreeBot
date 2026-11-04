import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';

export interface MonthlyStats {
  month: string;
  totalBought: number;
  totalSold: number;
  netFlow: number;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
}

export interface TraderAnalysis {
  address: string;
  label: string;
  analysisDate: string;
  periodMonths: number;
  trades: {
    total: number;
    buys: number;
    sells: number;
    firstTrade: string;
    lastTrade: string;
    daysActive: number;
  };
  volume: {
    totalBought: number;
    totalSold: number;
    netFlow: number;
  };
  positions: {
    total: number;
    open: number;
    winners: number;
    losers: number;
    winRate: number;
    initialValue: number;
    currentValue: number;
  };
  pnl: {
    unrealized: number;
    realized: number;
    total: number;
    roi: number;
    monthlyRoi: number;
    annualizedRoi: number;
  };
  redeemable: {
    count: number;
    value: number;
  };
  monthlyBreakdown: MonthlyStats[];
  topWinners: { title: string; outcome: string; pnl: number; roi: number }[];
  topLosers: { title: string; outcome: string; pnl: number; roi: number }[];
}

function parseUserAddressesFromEnv(): string[] {
  const raw =
    process.env.USER_ADDRESSES ||
    (() => {
      try {
        const envPath = path.join(process.cwd(), '..', '.env');
        if (!fs.existsSync(envPath)) return '';
        const match = fs.readFileSync(envPath, 'utf-8').match(/^USER_ADDRESSES\s*=\s*(.+)$/m);
        if (!match) return '';
        let v = match[1].trim();
        if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
          v = v.slice(1, -1);
        }
        return v;
      } catch {
        return '';
      }
    })();

  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      return (JSON.parse(trimmed) as string[]).map((a) => a.toLowerCase().trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

function placeholderTrader(address: string): TraderAnalysis {
  return {
    address,
    label: `${address.slice(0, 6)}…${address.slice(-4)}`,
    analysisDate: new Date().toISOString(),
    periodMonths: 0,
    trades: {
      total: 0,
      buys: 0,
      sells: 0,
      firstTrade: '',
      lastTrade: '',
      daysActive: 0,
    },
    volume: { totalBought: 0, totalSold: 0, netFlow: 0 },
    positions: {
      total: 0,
      open: 0,
      winners: 0,
      losers: 0,
      winRate: 0,
      initialValue: 0,
      currentValue: 0,
    },
    pnl: {
      unrealized: 0,
      realized: 0,
      total: 0,
      roi: 0,
      monthlyRoi: 0,
      annualizedRoi: 0,
    },
    redeemable: { count: 0, value: 0 },
    monthlyBreakdown: [],
    topWinners: [],
    topLosers: [],
  };
}

export async function GET() {
  try {
    const reportsDir = path.join(process.cwd(), '..', 'trader_reports');
    const summaryPath = path.join(reportsDir, '_SUMMARY.json');

    if (fs.existsSync(summaryPath)) {
      const summaryData = fs.readFileSync(summaryPath, 'utf-8');
      const traders: TraderAnalysis[] = JSON.parse(summaryData);
      return NextResponse.json({ traders, source: 'reports' });
    }

    if (fs.existsSync(reportsDir)) {
      const files = fs.readdirSync(reportsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('_'));
      const traders: TraderAnalysis[] = [];

      for (const file of jsonFiles) {
        const filePath = path.join(reportsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        traders.push(JSON.parse(content));
      }

      if (traders.length > 0) {
        return NextResponse.json({ traders, source: 'reports' });
      }
    }

    // Coolify / paper mode: no analyze reports yet — list configured wallets
    const addresses = parseUserAddressesFromEnv();
    if (addresses.length > 0) {
      return NextResponse.json({
        traders: addresses.map(placeholderTrader),
        source: 'env',
        message:
          'Showing wallets from USER_ADDRESSES. Run npm run analyze for full P&L charts.',
      });
    }

    return NextResponse.json(
      {
        error:
          'No traders configured. Set USER_ADDRESSES or run npm run analyze to generate trader_reports.',
      },
      { status: 404 }
    );
  } catch (error) {
    console.error('Error reading trader reports:', error);
    return NextResponse.json(
      { error: 'Failed to read trader reports' },
      { status: 500 }
    );
  }
}
