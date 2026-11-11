import { NextResponse } from 'next/server';
import { buildBotTradeRows } from '@/lib/paperLedger';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperModeAsync } from '@/lib/botMode';

export async function GET() {
  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    const { trades, summary } = await buildBotTradeRows(undefined, {
      paperMode: mode.paperMode,
    });

    return NextResponse.json({
      trades,
      summary: {
        ...summary,
        paper: mode.paperMode,
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
