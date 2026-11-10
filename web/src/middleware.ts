import { NextRequest, NextResponse } from 'next/server';

const SESSION_COOKIE = 'agreebot_session';

function authConfigured(): boolean {
  return Boolean(
    (process.env.DASHBOARD_USER || '').trim() &&
      (process.env.DASHBOARD_TOKEN || '').trim()
  );
}

/** Edge-compatible HMAC via Web Crypto is awkward; compare precomputed expected in Node middleware. */
async function expectedSession(): Promise<string> {
  const user = (process.env.DASHBOARD_USER || '').trim();
  const token = (process.env.DASHBOARD_TOKEN || '').trim();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`agreebot:${user}`)
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isPublicPath(pathname: string): boolean {
  if (pathname === '/login') return true;
  if (pathname.startsWith('/api/auth/')) return true;
  // Coolify / probes
  if (pathname === '/api/health' || pathname === '/health' || pathname === '/healthz') {
    return true;
  }
  return false;
}

export async function middleware(request: NextRequest) {
  if (!authConfigured()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const expected = await expectedSession();
  if (cookie && cookie === expected) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
     * Skip Next internals and static assets.
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
