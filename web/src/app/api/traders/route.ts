import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfiguredTraderAddresses,
  normalizeTraderAddresses,
} from '@/lib/runtimeSettings';
import { getUserAddressesFromEnv } from '@/lib/mongo';
import { stripQuotes } from '@/lib/env';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    stripQuotes(process.env.USER_ADDRESSES || '') ||
    (() => {
      try {
        const envPath = path.join(process.cwd(), '..', '.env');
        if (!fs.existsSync(envPath)) return '';
        const match = fs.readFileSync(envPath, 'utf-8').match(/^USER_ADDRESSES\s*=\s*(.+)$/m);
        if (!match) return '';
        return stripQuotes(match[1]);
      } catch {
        return '';
      }
    })();

  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      return normalizeTraderAddresses(JSON.parse(trimmed) as string[]);
    } catch {
      return [];
    }
  }
  return normalizeTraderAddresses(trimmed.split(','));
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

function alignToConfigured(
  reports: TraderAnalysis[],
  configured: string[]
): TraderAnalysis[] {
  if (configured.length === 0) return [];
  const byAddr = new Map(
    reports.map((t) => [t.address.toLowerCase(), t] as const)
  );
  return configured.map(
    (addr) => byAddr.get(addr.toLowerCase()) || placeholderTrader(addr)
  );
}

export async function GET() {
  try {
    const envAddresses = parseUserAddressesFromEnv();
    const configured = await getConfiguredTraderAddresses(
      envAddresses.length > 0 ? envAddresses : getUserAddressesFromEnv()
    );

    const reportsDir = path.join(process.cwd(), '..', 'trader_reports');
    const summaryPath = path.join(reportsDir, '_SUMMARY.json');

    if (fs.existsSync(summaryPath)) {
      const summaryData = fs.readFileSync(summaryPath, 'utf-8');
      const traders: TraderAnalysis[] = JSON.parse(summaryData);
      if (configured.length > 0) {
        return NextResponse.json({
          traders: alignToConfigured(traders, configured),
          source: 'reports+settings',
        });
      }
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
        if (configured.length > 0) {
          return NextResponse.json({
            traders: alignToConfigured(traders, configured),
            source: 'reports+settings',
          });
        }
        return NextResponse.json({ traders, source: 'reports' });
      }
    }

    // Coolify / paper mode: no analyze reports yet — list configured wallets
    if (configured.length > 0) {
      return NextResponse.json({
        traders: configured.map(placeholderTrader),
        source: 'settings',
        message:
          'Showing wallets from Settings / USER_ADDRESSES. Run npm run analyze for full P&L charts.',
      });
    }

    return NextResponse.json(
      {
        error:
          'No traders configured. Add wallets in Settings or set USER_ADDRESSES.',
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
