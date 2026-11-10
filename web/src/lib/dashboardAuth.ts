import { createHmac, timingSafeEqual } from 'crypto';

export const SESSION_COOKIE = 'agreebot_session';

export function isDashboardAuthConfigured(): boolean {
  const user = (process.env.DASHBOARD_USER || '').trim();
  const token = (process.env.DASHBOARD_TOKEN || '').trim();
  return Boolean(user && token);
}

export function getDashboardCredentials(): { user: string; token: string } | null {
  if (!isDashboardAuthConfigured()) return null;
  return {
    user: (process.env.DASHBOARD_USER || '').trim(),
    token: (process.env.DASHBOARD_TOKEN || '').trim(),
  };
}

/** Deterministic session value — knowing DASHBOARD_TOKEN proves login. */
export function expectedSessionValue(user: string, token: string): string {
  return createHmac('sha256', token).update(`agreebot:${user}`).digest('hex');
}

export function credentialsMatch(
  user: string,
  token: string,
  expectedUser: string,
  expectedToken: string
): boolean {
  try {
    const uOk =
      user.length === expectedUser.length &&
      timingSafeEqual(Buffer.from(user), Buffer.from(expectedUser));
    const tOk =
      token.length === expectedToken.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
    return uOk && tOk;
  } catch {
    return false;
  }
}

export function sessionIsValid(cookieValue: string | undefined): boolean {
  const creds = getDashboardCredentials();
  if (!creds) return true; // auth disabled
  if (!cookieValue) return false;
  const expected = expectedSessionValue(creds.user, creds.token);
  try {
    return (
      cookieValue.length === expected.length &&
      timingSafeEqual(Buffer.from(cookieValue), Buffer.from(expected))
    );
  } catch {
    return false;
  }
}
