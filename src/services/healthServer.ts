import http from 'http';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { getConsensusBufferSize, getConsensusStatus } from './consensus';
import {
    clearPaperBook,
    getOpenPaperPositionCount,
    loadPaperPositionsFromDb,
} from './paperPositions';
import { getMartingaleCircle } from './martingaleState';

let server: http.Server | null = null;
let startedAt = Date.now();

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

/**
 * Lightweight HTTP health server for Coolify / Docker healthchecks.
 * Does not require Express — uses Node's built-in http module.
 */
export const startHealthServer = (): void => {
    const port = ENV.HEALTH_PORT;

    server = http.createServer(async (req, res) => {
        const url = (req.url || '/').split('?')[0];
        const method = (req.method || 'GET').toUpperCase();

        if (url === '/health' || url === '/healthz' || url === '/') {
            const { getClobClient } = await import('./clobClientHolder');
            json(res, 200, {
                status: 'ok',
                mode: ENV.PAPER_MODE ? 'paper' : 'live',
                paperMode: ENV.PAPER_MODE,
                clobReady: !!getClobClient(),
                uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                traders: ENV.USER_ADDRESSES.length,
                paperOpenPositions: getOpenPaperPositionCount(),
                copyStrategy: ENV.COPY_STRATEGY_CONFIG.strategy,
                maxOrderSizeUSD: ENV.COPY_STRATEGY_CONFIG.maxOrderSizeUSD,
                martingale: {
                    baseShares: ENV.COPY_STRATEGY_CONFIG.martingaleBaseShares ?? 5,
                    maxSteps: ENV.COPY_STRATEGY_CONFIG.martingaleMaxSteps ?? 8,
                    ...getMartingaleCircle(ENV.PAPER_MODE),
                },
                consensus: {
                    enabled: ENV.CONSENSUS_ENABLED,
                    minAgreement: ENV.CONSENSUS_MIN_AGREEMENT,
                    pendingGroups: getConsensusBufferSize(),
                    pending: getConsensusStatus(),
                },
                timestamp: new Date().toISOString(),
            });
            return;
        }

        if (url === '/ready') {
            json(res, 200, { ready: true });
            return;
        }

        // Dashboard calls this after wiping Mongo + ledger so the live book matches.
        if (url === '/paper/reset' && method === 'POST') {
            if (!ENV.PAPER_MODE) {
                json(res, 400, {
                    ok: false,
                    error: 'Paper mode is off — refusing to clear the paper book',
                });
                return;
            }
            try {
                const cleared = clearPaperBook();
                await loadPaperPositionsFromDb();
                json(res, 200, {
                    ok: true,
                    clearedOpenPositions: cleared,
                    openAfterReload: getOpenPaperPositionCount(),
                });
            } catch (error) {
                json(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        // Dashboard Settings / health — paper bankroll or CLOB collateral
        if (url === '/balance' && method === 'GET') {
            try {
                if (ENV.PAPER_MODE) {
                    const paper =
                        Number.isFinite(ENV.PAPER_BALANCE_USD) && ENV.PAPER_BALANCE_USD > 0
                            ? ENV.PAPER_BALANCE_USD
                            : 0;
                    json(res, 200, {
                        ok: true,
                        usdc: paper,
                        proxyWallet: ENV.PROXY_WALLET || '',
                        source: 'paper',
                        paperMode: true,
                    });
                    return;
                }

                // Live: use shared CLOB client only (do not fall back to on-chain $0)
                const { ensureClobClient } = await import('./clobClientHolder');
                await ensureClobClient();
                const { getClobCollateralBalance } = await import('../utils/getMyBalance');
                const usdc = await getClobCollateralBalance();
                if (usdc === null) {
                    json(res, 200, {
                        ok: false,
                        usdc: null,
                        proxyWallet: ENV.PROXY_WALLET || '',
                        source: 'clob',
                        paperMode: false,
                        error: 'CLOB balance unavailable — client not ready or fetch failed',
                    });
                    return;
                }
                json(res, 200, {
                    ok: true,
                    usdc,
                    proxyWallet: ENV.PROXY_WALLET || '',
                    source: 'clob',
                    paperMode: false,
                });
            } catch (error) {
                json(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        // Dashboard Settings save → re-apply Mongo overrides without container restart
        if (url === '/runtime/reload' && method === 'POST') {
            try {
                const { applyRuntimeOverrides } = await import('./runtimeSettings');
                const { ensureClobClient, getClobClient } = await import('./clobClientHolder');
                await applyRuntimeOverrides();
                await ensureClobClient();
                let gravia: { ok: boolean; message: string } | undefined;
                if (ENV.GRAVIA_FEED_ENABLED) {
                    const { syncGraviaSubscription } = await import('./graviaSync');
                    gravia = await syncGraviaSubscription(ENV.USER_ADDRESSES);
                }
                Logger.success(
                    `Runtime settings reloaded (strategy=${ENV.COPY_STRATEGY_CONFIG.strategy}, minAgreement=${ENV.CONSENSUS_MIN_AGREEMENT}, traders=${ENV.USER_ADDRESSES.length}, paper=${ENV.PAPER_MODE}, clob=${!!getClobClient()})`
                );
                json(res, 200, {
                    ok: true,
                    traders: ENV.USER_ADDRESSES.length,
                    copyStrategy: ENV.COPY_STRATEGY_CONFIG.strategy,
                    maxOrderSizeUSD: ENV.COPY_STRATEGY_CONFIG.maxOrderSizeUSD,
                    martingale: {
                        baseShares: ENV.COPY_STRATEGY_CONFIG.martingaleBaseShares ?? 5,
                        maxSteps: ENV.COPY_STRATEGY_CONFIG.martingaleMaxSteps ?? 8,
                        ...getMartingaleCircle(ENV.PAPER_MODE),
                    },
                    consensus: {
                        enabled: ENV.CONSENSUS_ENABLED,
                        minAgreement: ENV.CONSENSUS_MIN_AGREEMENT,
                        windowSeconds: ENV.CONSENSUS_WINDOW_SECONDS,
                        applyTo: ENV.CONSENSUS_APPLY_TO,
                        sizeMode: ENV.CONSENSUS_SIZE_MODE,
                    },
                    paperMode: ENV.PAPER_MODE,
                    clobReady: !!getClobClient(),
                    gravia,
                });
            } catch (error) {
                json(res, 500, {
                    ok: false,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
            return;
        }

        json(res, 404, { error: 'not found' });
    });

    server.listen(port, '0.0.0.0', () => {
        Logger.success(`Health server listening on :${port} (/health)`);
    });

    server.on('error', (err) => {
        Logger.warning(`Health server error: ${err.message}`);
    });
};

export const stopHealthServer = (): Promise<void> => {
    return new Promise((resolve) => {
        if (!server) {
            resolve();
            return;
        }
        server.close(() => {
            Logger.info('Health server stopped');
            resolve();
        });
    });
};
