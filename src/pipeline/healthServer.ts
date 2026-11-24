import http from 'http';
import { PIPELINE } from './config';
import { PipelineStatus, PIPELINE_STATUS_ID, CuratedTraderList, CURATED_LIST_ID } from './models';
import type { DiscoveryStats } from './discoveryStream';

let server: http.Server | null = null;

export function startPipelineHealthServer(getDiscovery: () => DiscoveryStats): void {
    server = http.createServer(async (req, res) => {
        if (req.url === '/health' || req.url === '/') {
            const status = (await PipelineStatus.findById(PIPELINE_STATUS_ID)
                .lean()
                .exec()) as {
                curatedCount?: number;
                lastEvalAt?: Date;
                lastEvalStats?: Record<string, unknown>;
                updatedAt?: Date;
            } | null;
            const curated = (await CuratedTraderList.findById(CURATED_LIST_ID)
                .lean()
                .exec()) as { addresses?: string[] } | null;
            const discovery = getDiscovery();
            const body = {
                ok: true,
                service: 'trader-pipeline',
                discovery,
                curatedCount: curated?.addresses?.length ?? status?.curatedCount ?? 0,
                lastEvalAt: status?.lastEvalAt,
                lastEvalStats: status?.lastEvalStats,
                updatedAt: status?.updatedAt,
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
            return;
        }

        if (req.url === '/curated') {
            const curated =
                (await CuratedTraderList.findById(CURATED_LIST_ID).lean().exec()) || {
                    addresses: [],
                    traders: [],
                };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(curated));
            return;
        }

        res.writeHead(404);
        res.end('not found');
    });

    server.listen(PIPELINE.HEALTH_PORT, '0.0.0.0', () => {
        console.log(`[pipeline] health on :${PIPELINE.HEALTH_PORT}`);
    });
}

export async function stopPipelineHealthServer(): Promise<void> {
    await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
    });
}
