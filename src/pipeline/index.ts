/**
 * Crypto 5m trader discovery + maintenance worker.
 *
 * Runs as a SEPARATE Node process from the copy bot so Gravia WS/REST
 * evaluation never shares the bot event loop or order path.
 *
 * Start:
 *   npm run pipeline
 *   AGREEBOT_ROLE=pipeline node dist/pipeline/index.js
 */
import { assertPipelineConfig, PIPELINE } from './config';
import { connectPipelineDb, closePipelineDb } from './db';
import { DiscoveryStream } from './discoveryStream';
import { runEvaluationCycle } from './maintainList';
import { startPipelineHealthServer, stopPipelineHealthServer } from './healthServer';
import { PipelineStatus, PIPELINE_STATUS_ID, CandidateTrader } from './models';

async function main(): Promise<void> {
    if (!PIPELINE.ENABLED) {
        console.log('[pipeline] TRADER_PIPELINE_ENABLED=false — exiting');
        process.exit(0);
    }

    assertPipelineConfig();
    await connectPipelineDb();

    const discovery = new DiscoveryStream();
    const startedAt = new Date();

    await PipelineStatus.findByIdAndUpdate(
        PIPELINE_STATUS_ID,
        {
            $set: {
                startedAt,
                updatedAt: startedAt,
                discoveryConnected: false,
                lastError: undefined,
            },
        },
        { upsert: true }
    );

    startPipelineHealthServer(() => discovery.stats);
    await discovery.start();

    const statusPulse = setInterval(async () => {
        const candidates = await CandidateTrader.countDocuments().exec();
        await PipelineStatus.findByIdAndUpdate(PIPELINE_STATUS_ID, {
            $set: {
                updatedAt: new Date(),
                discoveryConnected: discovery.stats.connected,
                marketsTracked: discovery.stats.marketsTracked,
                candidates,
                lastError: discovery.stats.lastError,
            },
        });
    }, 30_000);

    // First eval after a short discovery warmup
    setTimeout(() => {
        runEvaluationCycle().catch((err) => {
            console.error('[pipeline] eval cycle error', err);
        });
    }, 45_000);

    const evalTimer = setInterval(() => {
        runEvaluationCycle().catch((err) => {
            console.error('[pipeline] eval cycle error', err);
        });
    }, PIPELINE.EVAL_INTERVAL_MS);

    const shutdown = async (signal: string) => {
        console.log(`[pipeline] ${signal} — shutting down`);
        clearInterval(evalTimer);
        clearInterval(statusPulse);
        discovery.stop();
        await stopPipelineHealthServer();
        await closePipelineDb();
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    console.log(
        `[pipeline] running | list=${PIPELINE.LIST_SIZE} minRoi=${PIPELINE.MIN_ROI} minWR=${PIPELINE.MIN_WIN_RATE} ` +
            `≥${PIPELINE.MIN_TRADES_PER_DAY} trades/day ≥${PIPELINE.MIN_ACTIVE_DAYS_PER_WEEK} days/week ` +
            `autoApply=${PIPELINE.AUTO_APPLY} rate=${PIPELINE.RATE_LIMIT_PER_MIN}/min`
    );
}

main().catch(async (error) => {
    console.error('[pipeline] fatal', error);
    try {
        await closePipelineDb();
    } catch {
        /* ignore */
    }
    process.exit(1);
});
