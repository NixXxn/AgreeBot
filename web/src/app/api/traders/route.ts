import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfiguredTraderAddresses,
  normalizeTraderAddresses,
} from '@/lib/runtimeSettings';
import { getUserAddressesFromEnv } from '@/lib/mongo';
import { stripQuotes } from '@/lib/env';
import { buildLiveTraderReports } from '@/lib/liveTraderStats';
import type { TraderAnalysis } from '@/types/trader';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    dailyBreakdown: [],
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

function reportsLookPopulated(reports: TraderAnalysis[]): boolean {
  return reports.some(
    (t) =>
      t.trades.total > 0 ||
      t.positions.total > 0 ||
      Math.abs(t.pnl.total) > 0 ||
      t.volume.totalBought > 0
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const forceLive = searchParams.get('refresh') === 'true';

  try {
    const envAddresses = parseUserAddressesFromEnv();
    const configured = await getConfiguredTraderAddresses(
      envAddresses.length > 0 ? envAddresses : getUserAddressesFromEnv()
    );

    const reportsDir = path.join(process.cwd(), '..', 'trader_reports');
    const summaryPath = path.join(reportsDir, '_SUMMARY.json');

    let fileReports: TraderAnalysis[] = [];

    if (!forceLive && fs.existsSync(summaryPath)) {
      try {
        fileReports = JSON.parse(fs.readFileSync(summaryPath, 'utf-8')) as TraderAnalysis[];
      } catch {
        fileReports = [];
      }
    } else if (!forceLive && fs.existsSync(reportsDir)) {
      const files = fs.readdirSync(reportsDir);
      const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('_'));
      for (const file of jsonFiles) {
        try {
          fileReports.push(
            JSON.parse(fs.readFileSync(path.join(reportsDir, file), 'utf-8')) as TraderAnalysis
          );
        } catch {
          /* skip bad file */
        }
      }
    }

    if (configured.length > 0 && fileReports.length > 0) {
      const aligned = alignToConfigured(fileReports, configured);
      if (reportsLookPopulated(aligned)) {
        return NextResponse.json({
          traders: aligned,
          source: 'reports+settings',
        });
      }
    } else if (configured.length === 0 && fileReports.length > 0 && reportsLookPopulated(fileReports)) {
      return NextResponse.json({ traders: fileReports, source: 'reports' });
    }

    // No usable offline reports — Mongo cache first, Data API only for stale/missing
    if (configured.length > 0) {
      try {
        const live = await buildLiveTraderReports(configured, {
          forceRefresh: forceLive,
        });
        return NextResponse.json({
          traders: live.traders,
          source: live.source,
          refreshed: live.refreshed,
          cached: live.cached,
          message: live.message,
        });
      } catch (error) {
        console.error('Live trader stats failed:', error);
        return NextResponse.json({
          traders: configured.map(placeholderTrader),
          source: 'settings',
          message:
            'Could not fetch live trader stats. Showing wallet list only — retry refresh.',
        });
      }
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
