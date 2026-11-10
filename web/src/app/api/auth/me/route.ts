import { NextResponse } from 'next/server';
import {
  SESSION_COOKIE,
  getDashboardCredentials,
  isDashboardAuthConfigured,
  sessionIsValid,
} from '@/lib/dashboardAuth';
import { cookies } from 'next/headers';

export async function GET() {
  if (!isDashboardAuthConfigured()) {
    return NextResponse.json({ authRequired: false, authenticated: true });
  }

  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;
  const ok = sessionIsValid(session);
  const creds = getDashboardCredentials();

  return NextResponse.json({
    authRequired: true,
    authenticated: ok,
    user: ok ? creds?.user : null,
  });
}
