import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import autoResolver, { stopAutoResolver } from './services/autoResolver';
import autoClaim, { stopAutoClaim } from './services/autoClaim';
import { startHealthServer, stopHealthServer } from './services/healthServer';
import { ensureClobClient, getClobClient } from './services/clobClientHolder';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';

const PROXY_WALLET = ENV.PROXY_WALLET;

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) {
        Logger.warning('Shutdown already in progress, forcing exit...');
        process.exit(1);
    }

    isShuttingDown = true;
    Logger.separator();
    Logger.info(`Received ${signal}, initiating graceful shutdown...`);

    try {
        // Stop services
        stopTradeMonitor();
        stopTradeExecutor();
        stopAutoResolver();
        stopAutoClaim();
        await stopHealthServer();

        // Give services time to finish current operations
        Logger.info('Waiting for services to finish current operations...');
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close database connection
        await closeDB();

        Logger.success('Graceful shutdown completed');
        process.exit(0);
    } catch (error) {
        Logger.error(`Error during shutdown: ${error}`);
        process.exit(1);
    }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    Logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
    // Don't exit immediately, let the application try to recover
});

// Handle uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    Logger.error(`Uncaught Exception: ${error.message}`);
    // Exit immediately for uncaught exceptions as the application is in an undefined state
    gracefulShutdown('uncaughtException').catch(() => {
        process.exit(1);
    });
});

// Handle termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export const main = async () => {
    try {
        await connectDB();

        // Dashboard edits (traders, strategy, …) live in Mongo and override Coolify env
        const { applyRuntimeOverrides } = await import('./services/runtimeSettings');
        await applyRuntimeOverrides();

        // USER_ADDRESSES const aliases the same array mutated by applyRuntimeOverrides
        Logger.startup(ENV.USER_ADDRESSES, PROXY_WALLET);

        if (ENV.PAPER_MODE) {
            Logger.warning(
                'PAPER MODE enabled — monitoring traders and logging signals only (no live orders)'
            );
        }

        if (ENV.CONSENSUS_ENABLED) {
            Logger.info(
                `Consensus trading enabled: ${ENV.CONSENSUS_MIN_AGREEMENT}+ of ${ENV.USER_ADDRESSES.length} traders must agree`
            );
        }

        // HTTP health endpoint for Coolify / Docker
        startHealthServer();

        // Perform initial health check
        Logger.info('Performing initial health check...');
        const healthResult = await performHealthCheck();
        logHealthCheck(healthResult);

        if (!healthResult.healthy) {
            Logger.warning('Health check failed, but continuing startup...');
        }

        if (ENV.PAPER_MODE) {
            const { cleanupOrphanPaperSells } = await import('./services/cleanupOrphanSells');
            const { loadPaperPositionsFromDb } = await import('./services/paperPositions');
            await cleanupOrphanPaperSells();
            await loadPaperPositionsFromDb();
        }

        await ensureClobClient();

        // Move mis-tagged "live" rows (void postOrder counted as filled) into paper ledger
        const { reclassifyBogusLiveSignals } = await import('./services/reclassifyLiveSignals');
        await reclassifyBogusLiveSignals();

        Logger.separator();
        // Finish historical priming before the executor runs, otherwise a restart
        // can mark brand-new trades as processed and consensus never starts.
        const { primeHistoricalTrades } = await import('./services/tradeMonitor');
        await primeHistoricalTrades();

        const { clearAllPendingConsensus } = await import('./services/consensus');
        await clearAllPendingConsensus();

        Logger.info('Starting trade monitor...');
        tradeMonitor();

        Logger.info('Starting trade executor...');
        tradeExecutor(getClobClient());

        if (ENV.AUTO_RESOLVE_ENABLED) {
            Logger.info('Starting auto resolver...');
            autoResolver();
        } else {
            Logger.info('Auto resolver disabled');
        }

        if (!ENV.PAPER_MODE && ENV.AUTO_CLAIM_ENABLED) {
            Logger.info('Starting auto claim (live winnings → connected wallet)...');
            autoClaim();
        } else {
            Logger.info(
                ENV.PAPER_MODE
                    ? 'Auto claim skipped (paper mode)'
                    : 'Auto claim disabled (AUTO_CLAIM_ENABLED=false)'
            );
        }

        // Pick up dashboard Settings changes even if the save-time notify missed
        setInterval(() => {
            applyRuntimeOverrides()
                .then(() => ensureClobClient())
                .catch((error) => {
                    Logger.warning(
                        `Periodic runtime reload failed: ${
                            error instanceof Error ? error.message : String(error)
                        }`
                    );
                });
        }, 30_000);
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
