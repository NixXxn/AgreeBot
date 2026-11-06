import { NextResponse } from 'next/server';
import { buildBotTradeRows } from '@/lib/paperLedger';

export async function GET() {
  try {
    const { trades, summary } = await buildBotTradeRows();

    return NextResponse.json({
      trades,
      summary,
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
