import { NextResponse } from 'next/server';
import { BalanceInfo } from '@/types/settings';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import {
  fetchBotClobBalance,
  getProcessOrFileEnv,
  resolveProxyWallet,
} from '@/lib/botMode';

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
    const proxyWallet = resolveProxyWallet(overrides);
    const rpcUrl =
      getProcessOrFileEnv('RPC_URL') ||
      'https://polygon-bor-rpc.publicnode.com';

    if (!proxyWallet) {
      return NextResponse.json(
        { error: 'Wallet not configured (set POLY_FUNDER or PROXY_WALLET)' },
        { status: 400 }
      );
    }

    const result: BalanceInfo & { source?: string } = {
      usdc: 0,
      matic: 0,
      proxyWallet,
      source: 'on-chain',
    };

    // Prefer CLOB collateral via bot (signature-type-3 trading cash)
    const clob = await fetchBotClobBalance();
    if (clob) {
      result.usdc = clob.usdc;
      result.source = clob.source;
      if (clob.proxyWallet) result.proxyWallet = clob.proxyWallet;
    } else {
      // Fallback: on-chain USDC.e (often $0 for Polymarket deposit wallets)
      const usdcContract =
        getProcessOrFileEnv('USDC_CONTRACT_ADDRESS') ||
        '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
      const usdcData = `0x70a08231000000000000000000000000${proxyWallet.slice(2)}`;
      const raw = await rpcCall(rpcUrl, 'eth_call', [
        { to: usdcContract, data: usdcData },
        'latest',
      ]);
      if (raw) {
        result.usdc = Number(BigInt(raw)) / 1e6;
      }
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
