import { NextResponse } from 'next/server';
import { readEnvFileValue, stripQuotes } from '@/lib/env';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { resetPaperStats } from '@/lib/paperLedger';

function envFlag(key: string, overrides: Record<string, string>): boolean {
  const raw =
    overrides[key] ||
    process.env[key] ||
    readEnvFileValue(key) ||
    '';
  return stripQuotes(raw) === 'true';
}

async function isPaperMode(): Promise<boolean> {
  const overrides = await getRuntimeOverrides();
  return envFlag('PAPER_MODE', overrides) || envFlag('PREVIEW_MODE', overrides);
}

export async function POST() {
  try {
    if (!(await isPaperMode())) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Paper mode is off. Reset only clears paper history — turn Paper mode on first.',
        },
        { status: 400 }
      );
    }

    const result = await resetPaperStats();

    return NextResponse.json({
      success: true,
      ...result,
      message: [
        `Deleted ${result.deletedMongo} paper signal(s) from MongoDB.`,
        result.clearedLedger ? 'Cleared paper_ledger.jsonl.' : null,
        result.botMessage,
      ]
        .filter(Boolean)
        .join(' '),
    });
  } catch (error) {
    console.error('Paper reset failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to reset paper stats',
      },
      { status: 500 }
    );
  }
}
