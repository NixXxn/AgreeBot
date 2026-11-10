import { NextResponse } from 'next/server';
import { buildBotTradeRows } from '@/lib/paperLedger';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperModeAsync } from '@/lib/botMode';

const TRADES_PAGE_LIMIT = 100;

export async function GET() {
  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    // Latest 100 of the active mode only — summary counts match the list
    const { trades, summary } = await buildBotTradeRows(undefined, {
      paperMode: mode.paperMode,
      limit: TRADES_PAGE_LIMIT,
    });

    return NextResponse.json({
      trades,
      summary: {
        ...summary,
        paper: mode.paperMode,
        limit: TRADES_PAGE_LIMIT,
      },
      paperMode: mode.paperMode,
      modeSource: mode.source,
      clobReady: mode.clobReady ?? null,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching trades:', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to fetch trades',
        trades: [],
      },
      { status: 500 }
    );
  }
}
