import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './logger';

/**
 * Public Polygon RPCs.
 * polygon-bor-rpc.publicnode.com often 403s eth_getTransactionReceipt
 * ("Archive requests require a personal token") — keep it last, not default.
 */
export const POLYGON_RPC_FALLBACKS = [
    'https://1rpc.io/matic',
    'https://polygon.drpc.org',
    'https://polygon-bor-rpc.publicnode.com',
] as const;

const DEFAULT_RPC = POLYGON_RPC_FALLBACKS[0];

export function resolveRpcUrlList(primary?: string): string[] {
    const preferred = (primary || ENV.RPC_URL || '').trim();
    const list: string[] = [];
    const add = (url: string) => {
        if (!url || !url.startsWith('http')) return;
        if (!list.includes(url)) list.push(url);
    };
    add(preferred);
    for (const url of POLYGON_RPC_FALLBACKS) add(url);
    if (list.length === 0) add(DEFAULT_RPC);
    return list;
}

function isArchiveOrAuthRpcError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /archive|personal token|allnodes|403|unauthorized|-32602/i.test(msg);
}

/**
 * Create a JsonRpcProvider that works against the first healthy endpoint.
 * Retries alternate public RPCs when the configured URL is dead/401.
 */
export async function createPolygonProvider(
    primary?: string
): Promise<ethers.providers.JsonRpcProvider> {
    const urls = resolveRpcUrlList(primary);
    let lastError: unknown;

    for (const url of urls) {
        try {
            const provider = new ethers.providers.JsonRpcProvider(url, {
                name: 'matic',
                chainId: 137,
            });
            // Force a network hit; ethers caches after first success
            await provider.getBlockNumber();
            if (url !== urls[0]) {
                Logger.warning(`RPC primary failed — using fallback ${url}`);
            } else if (/publicnode\.com/i.test(url)) {
                Logger.warning(
                    'RPC_URL is publicnode — eth_getTransactionReceipt may 403; set a personal Polygon RPC if redeems fail'
                );
            }
            return provider;
        } catch (error) {
            lastError = error;
            Logger.warning(
                `RPC unreachable (${url}): ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    throw lastError instanceof Error
        ? lastError
        : new Error('All Polygon RPC endpoints failed');
}

/** Wait for a tx receipt, rotating RPCs if the primary can't serve receipts. */
export async function waitForTxReceipt(
    primaryProvider: ethers.providers.JsonRpcProvider,
    txHash: string,
    confirmations = 1
): Promise<ethers.providers.TransactionReceipt> {
    try {
        return await primaryProvider.waitForTransaction(txHash, confirmations);
    } catch (error) {
        if (!isArchiveOrAuthRpcError(error)) throw error;

        Logger.warning(
            `Receipt wait failed on primary RPC (${error instanceof Error ? error.message : String(error)}) — trying fallbacks`
        );

        const primaryUrl = (primaryProvider as { connection?: { url?: string } }).connection
            ?.url;
        const urls = resolveRpcUrlList().filter((u) => u !== primaryUrl);
        let lastError: unknown = error;

        for (const url of urls) {
            try {
                const provider = new ethers.providers.JsonRpcProvider(url, {
                    name: 'matic',
                    chainId: 137,
                });
                // Poll a few times — tx may still be confirming
                for (let i = 0; i < 30; i++) {
                    const receipt = await provider.getTransactionReceipt(txHash);
                    if (receipt) {
                        Logger.success(`Got receipt via fallback RPC ${url}`);
                        return receipt;
                    }
                    await new Promise((r) => setTimeout(r, 2000));
                }
            } catch (fallbackError) {
                lastError = fallbackError;
                Logger.warning(
                    `Fallback RPC receipt failed (${url}): ${
                        fallbackError instanceof Error
                            ? fallbackError.message
                            : String(fallbackError)
                    }`
                );
            }
        }

        throw lastError instanceof Error
            ? lastError
            : new Error(`Could not fetch receipt for ${txHash}`);
    }
}

export async function probeRpcUrl(url: string): Promise<{ ok: boolean; message: string }> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_chainId',
                params: [],
            }),
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            return { ok: false, message: `HTTP ${res.status}` };
        }
        const data = (await res.json()) as { result?: string; error?: { message?: string } };
        if (data.error?.message) {
            return { ok: false, message: data.error.message };
        }
        if (data.result !== '0x89') {
            return { ok: false, message: `Unexpected chainId ${data.result || 'missing'}` };
        }
        return { ok: true, message: 'Polygon (137)' };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
