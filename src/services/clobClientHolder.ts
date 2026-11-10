import { ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import Logger from '../utils/logger';

let client: ClobClient | null = null;
let initPromise: Promise<ClobClient | null> | null = null;

export const getClobClient = (): ClobClient | null => client;

/**
 * Ensure a CLOB client exists when live. Clears it when paper mode is on.
 * Safe to call after runtime Settings reload flips paper → live.
 */
export const ensureClobClient = async (): Promise<ClobClient | null> => {
    if (ENV.PAPER_MODE) {
        if (client) {
            Logger.info('Paper mode on — releasing CLOB client');
        }
        client = null;
        initPromise = null;
        return null;
    }

    if (client) return client;

    if (!ENV.PRIVATE_KEY?.trim() || !ENV.PROXY_WALLET?.trim()) {
        Logger.error(
            'Live mode but PROXY_WALLET / PRIVATE_KEY (or POLY_*) missing — cannot create CLOB client'
        );
        return null;
    }

    if (!initPromise) {
        initPromise = (async () => {
            try {
                const createClobClient = (await import('../utils/createClobClient')).default;
                Logger.info('Initializing CLOB client for live trading...');
                const created = await createClobClient();
                client = created;
                Logger.success('CLOB client ready');
                return created;
            } catch (error) {
                initPromise = null;
                Logger.error(
                    `Failed to create CLOB client: ${
                        error instanceof Error ? error.message : String(error)
                    }`
                );
                return null;
            }
        })();
    }

    return initPromise;
};

export const setClobClient = (next: ClobClient | null): void => {
    client = next;
    initPromise = null;
};
