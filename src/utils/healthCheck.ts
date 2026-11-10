import mongoose from 'mongoose';
import { ENV } from '../config/env';
import getMyBalance from './getMyBalance';
import { fetchUserPositions } from './polymarketData';
import { probeRpcUrl, resolveRpcUrlList } from './rpcProvider';
import Logger from './logger';

export interface HealthCheckResult {
    healthy: boolean;
    checks: {
        database: { status: 'ok' | 'error'; message: string };
        rpc: { status: 'ok' | 'error'; message: string };
        balance: { status: 'ok' | 'error' | 'warning'; message: string; balance?: number };
        polymarketApi: { status: 'ok' | 'error'; message: string };
    };
    timestamp: number;
}

/**
 * Perform health check on all critical components
 */
export const performHealthCheck = async (): Promise<HealthCheckResult> => {
    const checks: HealthCheckResult['checks'] = {
        database: { status: 'error', message: 'Not checked' },
        rpc: { status: 'error', message: 'Not checked' },
        balance: { status: 'error', message: 'Not checked' },
        polymarketApi: { status: 'error', message: 'Not checked' },
    };

    // Check MongoDB connection
    try {
        if (mongoose.connection.readyState === 1) {
            // Ping the database
            if (mongoose.connection.db) {
                await mongoose.connection.db.admin().ping();
                checks.database = { status: 'ok', message: 'Connected' };
            } else {
                checks.database = { status: 'error', message: 'Database object not available' };
            }
        } else {
            checks.database = {
                status: 'error',
                message: `Connection state: ${mongoose.connection.readyState}`,
            };
        }
    } catch (error) {
        checks.database = {
            status: 'error',
            message: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Check RPC endpoint (try primary + public fallbacks; polygon-rpc.com is dead)
    if (ENV.PAPER_MODE && !ENV.RPC_URL) {
        checks.rpc = { status: 'ok', message: 'Skipped (paper mode)' };
    } else {
        const urls = resolveRpcUrlList();
        let rpcOk = false;
        const failures: string[] = [];
        for (const url of urls) {
            const probe = await probeRpcUrl(url);
            if (probe.ok) {
                const host = url.replace(/^https?:\/\//, '').split('/')[0];
                checks.rpc = {
                    status: 'ok',
                    message:
                        url === urls[0]
                            ? `RPC ok (${host})`
                            : `RPC ok via fallback (${host})`,
                };
                rpcOk = true;
                break;
            }
            failures.push(`${url}: ${probe.message}`);
        }
        if (!rpcOk) {
            checks.rpc = {
                status: 'error',
                message: failures[0] || 'All RPC endpoints failed',
            };
        }
    }

    // Check USDC balance (skipped without a wallet / in paper mode)
    if (ENV.PAPER_MODE || !ENV.PROXY_WALLET) {
        checks.balance = {
            status: 'ok',
            message: ENV.PAPER_MODE ? 'Skipped (paper mode)' : 'No PROXY_WALLET configured',
        };
    } else {
        try {
            const balance = await getMyBalance(ENV.PROXY_WALLET);
            if (balance > 0) {
                if (balance < 10) {
                    checks.balance = {
                        status: 'warning',
                        message: `Low balance: $${balance.toFixed(2)}`,
                        balance,
                    };
                } else {
                    checks.balance = {
                        status: 'ok',
                        message: `Balance: $${balance.toFixed(2)}`,
                        balance,
                    };
                }
            } else {
                checks.balance = {
                    status: 'error',
                    message:
                        'Zero CLOB collateral — Polymarket trading cash is $0 (wallet ERC-20 can still look funded in the UI if misread). Deposit USDC into your Polymarket balance.',
                    balance: 0,
                };
            }
        } catch (error) {
            checks.balance = {
                status: 'error',
                message: `Balance check failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }

    // Check Polymarket Data API v2
    try {
        await fetchUserPositions('0x0000000000000000000000000000000000000001', { limit: 1 });
        checks.polymarketApi = { status: 'ok', message: 'Data API v2 responding' };
    } catch (error) {
        checks.polymarketApi = {
            status: 'error',
            message: `API check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    // Determine overall health (RPC/balance not required to be perfect in paper mode)
    const healthy = ENV.PAPER_MODE
        ? checks.database.status === 'ok' && checks.polymarketApi.status === 'ok'
        : checks.database.status === 'ok' &&
          checks.rpc.status === 'ok' &&
          checks.balance.status !== 'error' &&
          checks.polymarketApi.status === 'ok';

    return {
        healthy,
        checks,
        timestamp: Date.now(),
    };
};

/**
 * Log health check results
 */
export const logHealthCheck = (result: HealthCheckResult): void => {
    Logger.separator();
    Logger.header('🏥 HEALTH CHECK');
    Logger.info(`Overall Status: ${result.healthy ? '✅ Healthy' : '❌ Unhealthy'}`);
    Logger.info(
        `Database: ${result.checks.database.status === 'ok' ? '✅' : '❌'} ${result.checks.database.message}`
    );
    Logger.info(
        `RPC: ${result.checks.rpc.status === 'ok' ? '✅' : '❌'} ${result.checks.rpc.message}`
    );
    Logger.info(
        `Balance: ${result.checks.balance.status === 'ok' ? '✅' : result.checks.balance.status === 'warning' ? '⚠️' : '❌'} ${result.checks.balance.message}`
    );
    Logger.info(
        `Polymarket API: ${result.checks.polymarketApi.status === 'ok' ? '✅' : '❌'} ${result.checks.polymarketApi.message}`
    );
    Logger.separator();
};
