import { NextResponse } from 'next/server';
import { buildPaperMyTradesResponse } from '@/lib/paperLedger';
import { buildBotMyTradesResponse } from '@/lib/botAnalytics';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import {
  fetchBotClobBalance,
  resolvePaperModeAsync,
  resolveProxyWallet,
} from '@/lib/botMode';
import { resolveDisplayBalanceUsd } from '@/lib/displayBalance';
import { computeMaxDrawdown } from '@/lib/maxDrawdown';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    const paperMode = mode.paperMode;
    const wallet = resolveProxyWallet(overrides);

    let clobUsdc: number | null = null;
    if (!paperMode) {
      try {
        const clob = await fetchBotClobBalance();
        if (clob && Number.isFinite(clob.usdc)) clobUsdc = clob.usdc;
      } catch {
        /* optional */
      }
    }

    const { balanceUsd, source: balanceSource } = resolveDisplayBalanceUsd({
      paperMode,
      clobUsdc,
    });

    if (paperMode) {
      const paper = await buildPaperMyTradesResponse();
      const startingEquity = balanceUsd ?? 0;
      const drawdown = computeMaxDrawdown(paper.allMyTrades, startingEquity);
      return NextResponse.json({
        ...paper,
        balanceUsd: balanceUsd ?? undefined,
        balanceSource,
        maxDrawdownUsd: drawdown.maxDrawdownUsd,
        maxDrawdownPct: drawdown.maxDrawdownPct,
        message:
          (paper.message || '') +
          (balanceUsd != null ? ` · paper balance $${balanceUsd.toFixed(2)}` : ''),
        modeSource: mode.source,
      });
    }

    // Live: ONLY bot_signals (entered) — never full wallet Data API history
    const live = await buildBotMyTradesResponse({
      paperMode: false,
      wallet,
      balanceUsd,
    });
    const drawdown = computeMaxDrawdown(
      live.allMyTrades,
      balanceUsd ?? 0
    );

    return NextResponse.json({
      ...live,
      balanceSource,
      maxDrawdownUsd: drawdown.maxDrawdownUsd,
      maxDrawdownPct: drawdown.maxDrawdownPct,
      modeSource: mode.source,
      clobReady: mode.clobReady ?? null,
      refreshed: refresh,
    });
  } catch (error) {
    console.error('Error fetching my trades:', error);
    try {
      const paper = await buildPaperMyTradesResponse();
      return NextResponse.json({
        ...paper,
        error:
          error instanceof Error ? error.message : 'Failed to fetch my trades',
        message: 'Fell back to paper ledger after live fetch error',
      });
    } catch {
      return NextResponse.json(
        {
          error:
            error instanceof Error ? error.message : 'Failed to fetch my trades',
        },
        { status: 500 }
      );
    }
  }
}
