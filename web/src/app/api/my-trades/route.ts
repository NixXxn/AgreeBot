import { NextResponse } from 'next/server';
import { buildPaperMyTradesResponse } from '@/lib/paperLedger';
import { buildBotMyTradesResponse } from '@/lib/botAnalytics';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import {
  fetchBotClobBalance,
  resolvePaperModeAsync,
  resolveProxyWallet,
} from '@/lib/botMode';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    const paperMode = mode.paperMode;
    const wallet = resolveProxyWallet(overrides);

    let balanceUsd: number | null = null;
    try {
      const clob = await fetchBotClobBalance();
      if (clob && Number.isFinite(clob.usdc)) balanceUsd = clob.usdc;
    } catch {
      /* optional */
    }

    if (paperMode) {
      const paper = await buildPaperMyTradesResponse();
      return NextResponse.json({
        ...paper,
        balanceUsd: balanceUsd ?? undefined,
        message:
          (paper.message || '') +
          (balanceUsd != null ? ` · balance $${balanceUsd.toFixed(2)}` : ''),
        modeSource: mode.source,
      });
    }

    // Live: ONLY bot_signals (entered) — never full wallet Data API history
    const live = await buildBotMyTradesResponse({
      paperMode: false,
      wallet,
      balanceUsd,
    });

    return NextResponse.json({
      ...live,
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
