import { NextResponse } from 'next/server';
import { buildBotTradeRows } from '@/lib/paperLedger';
import { listPendingConsensus } from '@/lib/consensusPending';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resolvePaperModeAsync } from '@/lib/botMode';

export async function GET() {
  try {
    const overrides: Record<string, string> = await getRuntimeOverrides().catch(
      () => ({})
    );
    const mode = await resolvePaperModeAsync(overrides);
    const windowSeconds =
      parseInt(
        overrides.CONSENSUS_WINDOW_SECONDS ||
          process.env.CONSENSUS_WINDOW_SECONDS ||
          '2400',
        10
      ) || 2400;

    const [{ trades, summary }, pendingConsensus] = await Promise.all([
      buildBotTradeRows(undefined, { paperMode: mode.paperMode }),
      listPendingConsensus(windowSeconds),
    ]);

    return NextResponse.json({
      trades,
      pendingConsensus,
      summary: {
        ...summary,
        paper: mode.paperMode,
        pendingGroups: pendingConsensus.length,
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
        pendingConsensus: [],
      },
      { status: 500 }
    );
  }
}
