import { NextResponse } from 'next/server';
import { BalanceInfo } from '@/types/settings';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import {
  fetchBotClobBalance,
  getProcessOrFileEnv,
  resolvePaperModeAsync,
  resolveProxyWallet,
} from '@/lib/botMode';
import { resolveDisplayBalanceUsd } from '@/lib/displayBalance';

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[]
): Promise<string | null> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const json = await response.json();
  return typeof json.result === 'string' ? json.result : null;
}

export async function GET() {
  try {
    const overrides = await getRuntimeOverrides().catch(() => ({}));
    const mode = await resolvePaperModeAsync(overrides);
    const proxyWallet = resolveProxyWallet(overrides);
    const rpcUrl =
      getProcessOrFileEnv('RPC_URL') ||
      'https://polygon-bor-rpc.publicnode.com';

    // Paper mode: show virtual bankroll even without a wallet
    if (mode.paperMode) {
      const { balanceUsd } = resolveDisplayBalanceUsd({
        paperMode: true,
        clobUsdc: null,
      });
      return NextResponse.json({
        usdc: balanceUsd ?? 0,
        matic: 0,
        proxyWallet: proxyWallet || '',
        source: 'paper',
        paperMode: true,
      } satisfies BalanceInfo & { source?: string; paperMode?: boolean });
    }

    if (!proxyWallet) {
      return NextResponse.json(
        { error: 'Wallet not configured (set POLY_FUNDER or PROXY_WALLET)' },
        { status: 400 }
      );
    }

    const result: BalanceInfo = {
      usdc: 0,
      matic: 0,
      proxyWallet,
      source: 'clob-unavailable',
      paperMode: false,
    };

    // Prefer CLOB collateral via bot (signature-type-3 trading cash).
    // Do not fall back to on-chain USDC.e here — deposit wallets often show $0
    // on-chain while CLOB collateral is funded, which made live mode look empty.
    const clob = await fetchBotClobBalance();
    if (clob && clob.source !== 'paper') {
      result.usdc = clob.usdc;
      result.source = clob.source;
      if (clob.proxyWallet) result.proxyWallet = clob.proxyWallet;
    } else {
      result.source = 'clob-unavailable';
      // Keep usdc at 0 but mark unavailable so UI can show "—" via source check
    }

    const maticRaw = await rpcCall(rpcUrl, 'eth_getBalance', [
      proxyWallet,
      'latest',
    ]);
    if (maticRaw) {
      result.matic = Number(BigInt(maticRaw)) / 1e18;
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching balance:', error);
    return NextResponse.json(
      { error: 'Failed to fetch balance' },
      { status: 500 }
    );
  }
}
