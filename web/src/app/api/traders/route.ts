import { NextResponse } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import {
  getConfiguredTraderAddresses,
  getRuntimeOverrides,
  normalizeTraderAddresses,
} from '@/lib/runtimeSettings';
import { getUserAddressesFromEnv } from '@/lib/mongo';
import { stripQuotes } from '@/lib/env';
import { buildBotCopyTraderAnalyses } from '@/lib/botAnalytics';
import {
  fetchBotClobBalance,
  resolvePaperModeAsync,
} from '@/lib/botMode';
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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const envAddresses = parseUserAddressesFromEnv();
    const configured = await getConfiguredTraderAddresses(
      envAddresses.length > 0 ? envAddresses : getUserAddressesFromEnv()
    );

    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);

    let balanceUsd: number | null = null;
    try {
      const clob = await fetchBotClobBalance();
      if (clob && Number.isFinite(clob.usdc)) balanceUsd = clob.usdc;
    } catch {
      /* optional */
    }

    if (configured.length === 0) {
      return NextResponse.json(
        {
          error:
            'No traders configured. Add wallets in Settings or set USER_ADDRESSES.',
        },
        { status: 404 }
      );
    }

    // Bot-copy attribution only — never Polymarket Data API trader histories
    const { traders, message } = await buildBotCopyTraderAnalyses({
      paperMode: mode.paperMode,
      configuredAddresses: configured,
    });

    // Ensure every configured wallet appears (zeros if no bot fills yet)
    const byAddr = new Map(traders.map((t) => [t.address.toLowerCase(), t]));
    const aligned = configured.map(
      (addr) => byAddr.get(addr.toLowerCase()) || placeholderTrader(addr)
    );

    return NextResponse.json({
      traders: aligned,
      source: 'bot-ledger',
      paperMode: mode.paperMode,
      modeSource: mode.source,
      balanceUsd,
      refreshed: refresh,
      message:
        message +
        (balanceUsd != null ? ` · balance $${balanceUsd.toFixed(2)}` : ''),
    });
  } catch (error) {
    console.error('Error building bot trader analytics:', error);
    return NextResponse.json(
      { error: 'Failed to build bot trader analytics' },
      { status: 500 }
    );
  }
}
