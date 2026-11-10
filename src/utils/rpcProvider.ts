import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './logger';

/** Public Polygon RPCs — polygon-rpc.com returns 401 (tenant disabled). */
export const POLYGON_RPC_FALLBACKS = [
    'https://polygon-bor-rpc.publicnode.com',
    'https://1rpc.io/matic',
    'https://polygon.drpc.org',
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
            await provider.getNetwork();
            if (url !== urls[0]) {
                Logger.warning(`RPC primary failed — using fallback ${url}`);
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
