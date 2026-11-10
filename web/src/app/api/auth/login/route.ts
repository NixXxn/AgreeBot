import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  credentialsMatch,
  expectedSessionValue,
  getDashboardCredentials,
  isDashboardAuthConfigured,
} from '@/lib/dashboardAuth';

export async function POST(request: Request) {
  if (!isDashboardAuthConfigured()) {
    return NextResponse.json(
      { error: 'Dashboard auth is not configured (set DASHBOARD_USER + DASHBOARD_TOKEN)' },
      { status: 400 }
    );
  }

  const creds = getDashboardCredentials()!;
  let body: { user?: string; token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const user = String(body.user || '').trim();
  const token = String(body.token || '').trim();

  if (!credentialsMatch(user, token, creds.user, creds.token)) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const session = expectedSessionValue(creds.user, creds.token);
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
