import { NextResponse } from 'next/server';

/** Coolify / Docker healthcheck — public path /health */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'agreebot-dashboard',
    timestamp: new Date().toISOString(),
  });
}
