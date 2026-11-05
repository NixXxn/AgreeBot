import connectDB, { closeDB } from './config/db';
import { ENV } from './config/env';
import createClobClient from './utils/createClobClient';
import tradeExecutor, { stopTradeExecutor } from './services/tradeExecutor';
import tradeMonitor, { stopTradeMonitor } from './services/tradeMonitor';
import autoResolver, { stopAutoResolver } from './services/autoResolver';
import { startHealthServer, stopHealthServer } from './services/healthServer';
import Logger from './utils/logger';
import { performHealthCheck, logHealthCheck } from './utils/healthCheck';
import { ClobClient } from '@polymarket/clob-client';

const USER_ADDRESSES = ENV.USER_ADDRESSES;
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
        Logger.startup(USER_ADDRESSES, PROXY_WALLET);

        if (ENV.PAPER_MODE) {
            Logger.warning(
                'PAPER MODE enabled — monitoring traders and logging signals only (no live orders)'
            );
        }

        if (ENV.CONSENSUS_ENABLED) {
            Logger.info(
                `Consensus trading enabled: ${ENV.CONSENSUS_MIN_AGREEMENT}+ of ${USER_ADDRESSES.length} traders must agree`
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

        let clobClient: ClobClient | null = null;
        if (ENV.PAPER_MODE) {
            Logger.info('Skipping CLOB client (paper mode — no private key required)');
        } else {
            Logger.info('Initializing CLOB client...');
            clobClient = await createClobClient();
            Logger.success('CLOB client ready');
        }

        Logger.separator();
        Logger.info('Starting trade monitor...');
        tradeMonitor();

        Logger.info('Starting trade executor...');
        tradeExecutor(clobClient);

        if (!ENV.PAPER_MODE && ENV.AUTO_RESOLVE_ENABLED && clobClient) {
            Logger.info('Starting auto resolver...');
            autoResolver(clobClient);
        } else if (ENV.PAPER_MODE) {
            Logger.info('Auto resolver skipped (paper mode)');
        }
    } catch (error) {
        Logger.error(`Fatal error during startup: ${error}`);
        await gracefulShutdown('startup-error');
    }
};

main();
