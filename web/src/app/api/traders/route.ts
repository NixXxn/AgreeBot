import { NextResponse } from 'next/server';
import {
  getConfiguredTraderAddresses,
  getRuntimeOverrides,
} from '@/lib/runtimeSettings';
import { buildBotCopyTraderAnalyses } from '@/lib/botAnalytics';
import {
  fetchBotClobBalance,
  resolvePaperModeAsync,
} from '@/lib/botMode';
import { resolveDisplayBalanceUsd } from '@/lib/displayBalance';
import type { TraderAnalysis } from '@/types/trader';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

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
    const configured = await getConfiguredTraderAddresses();

    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);

    let clobUsdc: number | null = null;
    if (!mode.paperMode) {
      try {
        const clob = await fetchBotClobBalance();
        if (clob && Number.isFinite(clob.usdc)) clobUsdc = clob.usdc;
      } catch {
        /* optional */
      }
    }
    const { balanceUsd } = resolveDisplayBalanceUsd({
      paperMode: mode.paperMode,
      clobUsdc,
    });

    if (configured.length === 0) {
      return NextResponse.json(
        {
          error: 'No traders configured. Add wallets in Settings.',
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
    console.error('Failed to load traders:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load traders',
      },
      { status: 500 }
    );
  }
}
