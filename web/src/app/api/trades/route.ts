import { NextResponse } from 'next/server';
import { buildBotTradeRows } from '@/lib/paperLedger';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperMode } from '@/lib/botMode';

export async function GET() {
  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const paperMode = resolvePaperMode(overrides);
    const { trades, summary } = await buildBotTradeRows();

    return NextResponse.json({
      trades,
      summary: {
        ...summary,
        // Bot mode badge: Coolify live switch, not historical paper rows
        paper: paperMode,
        paperHistory: summary.paper,
      },
      paperMode,
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
