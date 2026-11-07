import http from 'http';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { getConsensusBufferSize, getConsensusStatus } from './consensus';
import {
    clearPaperBook,
    getOpenPaperPositionCount,
    loadPaperPositionsFromDb,
} from './paperPositions';

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
            json(res, 200, {
                status: 'ok',
                mode: ENV.PAPER_MODE ? 'paper' : 'live',
                uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                traders: ENV.USER_ADDRESSES.length,
                paperOpenPositions: getOpenPaperPositionCount(),
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
