import http from 'http';
import { ENV } from '../config/env';
import Logger from '../utils/logger';
import { getConsensusBufferSize, getConsensusStatus } from './consensus';

let server: http.Server | null = null;
let startedAt = Date.now();

/**
 * Lightweight HTTP health server for Coolify / Docker healthchecks.
 * Does not require Express — uses Node's built-in http module.
 */
export const startHealthServer = (): void => {
    const port = ENV.HEALTH_PORT;

    server = http.createServer((req, res) => {
        const url = req.url || '/';

        if (url === '/health' || url === '/healthz' || url === '/') {
            const body = JSON.stringify({
                status: 'ok',
                mode: ENV.PAPER_MODE ? 'paper' : 'live',
                uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
                traders: ENV.USER_ADDRESSES.length,
                consensus: {
                    enabled: ENV.CONSENSUS_ENABLED,
                    minAgreement: ENV.CONSENSUS_MIN_AGREEMENT,
                    pendingGroups: getConsensusBufferSize(),
                    pending: getConsensusStatus(),
                },
                timestamp: new Date().toISOString(),
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
            return;
        }

        if (url === '/ready') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ready: true }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
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
