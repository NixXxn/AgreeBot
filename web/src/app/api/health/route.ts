import { NextResponse } from 'next/server';
import { HealthCheckResult } from '@/types/settings';
import { getRuntimeOverrides } from '@/lib/runtimeSettings';
import { joinUrl, readEnvFileValue, stripQuotes } from '@/lib/env';

export async function GET() {
  let overrides: Record<string, string> = {};
  try {
    overrides = await getRuntimeOverrides();
  } catch (error) {
    console.warn('Health: could not load runtime overrides', error);
  }
  const getEnvValue = (key: string): string | undefined => {
    const raw =
      (overrides[key] !== undefined && overrides[key] !== ''
        ? overrides[key]
        : undefined) ??
      process.env[key] ??
      readEnvFileValue(key);
    return raw !== undefined ? stripQuotes(raw) : undefined;
  };

  const result: HealthCheckResult = {
    healthy: true,
    checks: {
      database: { status: 'ok' },
      rpc: { status: 'ok' },
      balance: { status: 'ok' },
      api: { status: 'ok' },
    },
    timestamp: new Date().toISOString(),
  };

  try {
    const mongoUri = getEnvValue('MONGO_URI');
    if (!mongoUri) {
      result.checks.database = { status: 'error', message: 'MONGO_URI not configured' };
      result.healthy = false;
    } else if (!mongoUri.startsWith('mongodb')) {
      result.checks.database = { status: 'error', message: 'Invalid MongoDB URI format' };
      result.healthy = false;
    }
  } catch (error) {
    result.checks.database = { status: 'error', message: String(error) };
    result.healthy = false;
  }

  const paperMode =
    getEnvValue('PAPER_MODE') === 'true' || getEnvValue('PREVIEW_MODE') === 'true';

  try {
    // polygon-rpc.com is dead (401). Prefer configured URL, then public fallbacks.
    const fallbacks = [
      'https://polygon-bor-rpc.publicnode.com',
      'https://1rpc.io/matic',
      'https://polygon.drpc.org',
    ];
    const configured = getEnvValue('RPC_URL');
    const urls = [
      ...(configured ? [configured] : []),
      ...fallbacks.filter((u) => u !== configured),
    ];

    if (urls.length === 0 && paperMode) {
      result.checks.rpc = { status: 'ok', message: 'Skipped (paper mode)' };
    } else {
      let ok = false;
      let lastErr = 'RPC_URL not configured';
      for (const rpcUrl of urls) {
        try {
          const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_chainId',
              params: [],
              id: 1,
            }),
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) {
            lastErr = `RPC returned ${response.status}`;
            continue;
          }
          const data = await response.json();
          if (data.error) {
            lastErr = data.error.message || 'RPC error';
            continue;
          }
          if (data.result !== '0x89') {
            lastErr = `Unexpected chainId ${data.result || 'missing'}`;
            continue;
          }
          const host = rpcUrl.replace(/^https?:\/\//, '').split('/')[0];
          result.checks.rpc = {
            status: 'ok',
            message:
              configured && rpcUrl === configured
                ? `OK (${host})`
                : `OK via fallback (${host})`,
          };
          ok = true;
          break;
        } catch (error) {
          lastErr = error instanceof Error ? error.message : String(error);
        }
      }
      if (!ok) {
        result.checks.rpc = { status: 'error', message: lastErr };
        result.healthy = false;
      }
    }
  } catch (error) {
    result.checks.rpc = { status: 'error', message: `RPC connection failed: ${error}` };
    result.healthy = false;
  }

  // Bot uses Data API v2 for trades. Settings "api" was wrongly failing on a
  // misconfigured CLOB_HTTP_URL /time ping even while the bot worked fine.
  try {
    const configuredClob = getEnvValue('CLOB_HTTP_URL') || 'https://clob.polymarket.com/';
    const probes: { name: string; url: string }[] = [
      {
        name: 'data-api',
        url: 'https://data-api.polymarket.com/v2/activity?user=0x0000000000000000000000000000000000000001&limit=1',
      },
      {
        name: 'clob',
        url: 'https://clob.polymarket.com/time',
      },
      {
        name: 'clob-configured',
        url: joinUrl(configuredClob, 'time'),
      },
    ];

    const ok: string[] = [];
    const failures: string[] = [];

    for (const probe of probes) {
      try {
        const response = await fetch(probe.url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        if (response.ok) {
          ok.push(probe.name);
        } else {
          failures.push(`${probe.name} ${response.status}`);
        }
      } catch (err) {
        failures.push(
          `${probe.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Healthy if the APIs the bot actually needs respond
    if (ok.includes('data-api') || ok.includes('clob')) {
      result.checks.api = {
        status: 'ok',
        message: `OK (${ok.join(', ')})`,
      };
    } else {
      result.checks.api = {
        status: 'error',
        message: `Polymarket unreachable (${failures.join('; ')})`,
      };
      result.healthy = false;
    }
  } catch (error) {
    result.checks.api = {
      status: 'error',
      message: `Polymarket API connection failed: ${error}`,
    };
    result.healthy = false;
  }

  try {
    const rpcUrl = getEnvValue('RPC_URL');
    const proxyWallet = (getEnvValue('PROXY_WALLET') || '').replace(/^['"]|['"]$/g, '');
    const usdcContract =
      getEnvValue('USDC_CONTRACT_ADDRESS') || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

    if (paperMode || !proxyWallet || !/^0x[a-fA-F0-9]{40}$/i.test(proxyWallet)) {
      result.checks.balance = {
        status: 'ok',
        message: paperMode ? 'Skipped (paper mode)' : 'Wallet not configured',
      };
    } else if (rpcUrl) {
      const data = `0x70a08231000000000000000000000000${proxyWallet.slice(2).toLowerCase()}`;

      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_call',
          params: [{ to: usdcContract, data }, 'latest'],
          id: 1,
        }),
      });

      if (response.ok) {
        const json = await response.json();
        if (json.result) {
          const balanceWei = BigInt(json.result);
          const balance = Number(balanceWei) / 1e6;

          result.checks.balance = {
            status: balance < 10 ? 'warning' : 'ok',
            value: balance,
            message: balance < 10 ? `Low balance: $${balance.toFixed(2)}` : undefined,
          };

          if (balance < 1) {
            result.checks.balance.status = 'error';
            result.checks.balance.message = `Very low balance: $${balance.toFixed(2)}`;
            result.healthy = false;
          }
        }
      }
    } else {
      result.checks.balance = { status: 'warning', message: 'RPC not configured' };
    }
  } catch (error) {
    result.checks.balance = { status: 'error', message: `Failed to check balance: ${error}` };
  }

  return NextResponse.json(result);
}
