import { getEnvValue } from './env';

/** Virtual bankroll for paper sizing / display. */
export function getPaperBalanceUsd(): number {
  const raw = getEnvValue('PAPER_BALANCE_USD') || '10000';
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

/**
 * Balance shown in the dashboard:
 * - paper → PAPER_BALANCE_USD (not live CLOB dust)
 * - live → CLOB USDC when available
 */
export function resolveDisplayBalanceUsd(options: {
  paperMode: boolean;
  clobUsdc?: number | null;
}): { balanceUsd: number | null; source: 'paper' | 'clob' | 'none' } {
  if (options.paperMode) {
    return { balanceUsd: getPaperBalanceUsd(), source: 'paper' };
  }
  if (
    options.clobUsdc != null &&
    Number.isFinite(options.clobUsdc)
  ) {
    return { balanceUsd: options.clobUsdc, source: 'clob' };
  }
  return { balanceUsd: null, source: 'none' };
}
