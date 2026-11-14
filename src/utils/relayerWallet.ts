import { ethers } from 'ethers';
import { ENV } from '../config/env';
import Logger from './logger';

const RELAYER_URL = (
    process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com'
).replace(/\/$/, '');
const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const POLYGON_CHAIN_ID = 137;

export type DepositWalletCall = {
    target: string;
    value?: string;
    data: string;
};

export type RelayerExecResult = {
    success: boolean;
    txId?: string;
    txHash?: string;
    error?: string;
};

const relayerHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (ENV.RELAYER_API_KEY) {
        headers.RELAYER_API_KEY = ENV.RELAYER_API_KEY;
    }
    if (ENV.RELAYER_API_KEY_ADDRESS) {
        headers.RELAYER_API_KEY_ADDRESS = ENV.RELAYER_API_KEY_ADDRESS;
    }
    return headers;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const hasRelayerCreds = (): boolean =>
    Boolean(ENV.RELAYER_API_KEY?.trim() && ENV.RELAYER_API_KEY_ADDRESS?.trim());

/**
 * Prefer gasless deposit-wallet path when signature type 3 (or unset with funder)
 * and Relayer API keys are configured.
 */
export const shouldUseGaslessRelayer = (): boolean => {
    if (!hasRelayerCreds()) return false;
    if (!ENV.PROXY_WALLET?.trim() || !ENV.PRIVATE_KEY?.trim()) return false;
    const sig = ENV.POLY_SIGNATURE_TYPE;
    return sig === '3' || sig === '';
};

const pollRelayerTx = async (
    transactionID: string,
    timeoutMs = 120_000
): Promise<{ state: string; transactionHash?: string }> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const res = await fetch(`${RELAYER_URL}/v1/account/transactions/${transactionID}`, {
            headers: relayerHeaders(),
        });
        if (!res.ok) {
            await sleep(2000);
            continue;
        }
        const body = (await res.json()) as {
            state?: string;
            transactionHash?: string;
            hash?: string;
        };
        const state = (body.state || '').toUpperCase();
        if (
            state.includes('CONFIRMED') ||
            state.includes('MINED') ||
            state.includes('EXECUTED') ||
            state === 'STATE_CONFIRMED'
        ) {
            return {
                state,
                transactionHash: body.transactionHash || body.hash,
            };
        }
        if (
            state.includes('FAILED') ||
            state.includes('INVALID') ||
            state === 'STATE_FAILED' ||
            state === 'STATE_INVALID'
        ) {
            return { state, transactionHash: body.transactionHash || body.hash };
        }
        await sleep(2500);
    }
    return { state: 'TIMEOUT' };
};

/**
 * Execute one or more contract calls gaslessly from the Polymarket deposit wallet
 * via relayer-v2 (type=WALLET). Requires RELAYER_API_KEY + RELAYER_API_KEY_ADDRESS.
 *
 * @see https://docs.polymarket.com/trading/wallets-auth#execute-gasless-transactions
 */
export const executeDepositWalletBatch = async (
    calls: DepositWalletCall[],
    metadata = 'AgreeBot wallet batch'
): Promise<RelayerExecResult> => {
    if (!hasRelayerCreds()) {
        return {
            success: false,
            error: 'RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS required',
        };
    }

    const funder = ENV.PROXY_WALLET?.trim();
    const pk = ENV.PRIVATE_KEY?.trim();
    if (!funder) return { success: false, error: 'PROXY_WALLET / POLY_FUNDER not set' };
    if (!pk) return { success: false, error: 'PRIVATE_KEY not set' };
    if (!calls.length) return { success: false, error: 'No calls to execute' };

    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
    const normalizedCalls = calls.map((c) => ({
        target: ethers.utils.getAddress(c.target),
        value: c.value || '0',
        data: c.data,
    }));

    const paramsRes = await fetch(
        `${RELAYER_URL}/v1/account/transactions/params?address=${wallet.address}&type=WALLET`,
        { headers: relayerHeaders() }
    );
    if (!paramsRes.ok) {
        const text = await paramsRes.text();
        return { success: false, error: `Relayer params failed: ${paramsRes.status} ${text}` };
    }
    const paramsBody = (await paramsRes.json()) as { nonce?: string | number };
    const nonce = String(paramsBody.nonce ?? '');
    if (!nonce) {
        return { success: false, error: 'Relayer returned empty nonce' };
    }

    const deadline = String(Math.floor(Date.now() / 1000) + 600);
    const domain = {
        name: 'DepositWallet',
        version: '1',
        chainId: POLYGON_CHAIN_ID,
        verifyingContract: funder,
    };
    const types = {
        Call: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
        ],
        Batch: [
            { name: 'wallet', type: 'address' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'calls', type: 'Call[]' },
        ],
    };
    const message = {
        wallet: funder,
        nonce,
        deadline,
        calls: normalizedCalls,
    };

    const signature = await wallet._signTypedData(domain, types, message);

    const submitRes = await fetch(`${RELAYER_URL}/submit`, {
        method: 'POST',
        headers: relayerHeaders(),
        body: JSON.stringify({
            type: 'WALLET',
            from: wallet.address,
            to: DEPOSIT_WALLET_FACTORY,
            nonce,
            signature,
            metadata,
            depositWalletParams: {
                depositWallet: funder,
                deadline,
                calls: normalizedCalls,
            },
        }),
    });

    if (!submitRes.ok) {
        const text = await submitRes.text();
        return { success: false, error: `Relayer submit failed: ${submitRes.status} ${text}` };
    }

    const submitBody = (await submitRes.json()) as {
        transactionID?: string;
        transactionId?: string;
        id?: string;
        error?: string;
    };
    const transactionID =
        submitBody.transactionID || submitBody.transactionId || submitBody.id || '';
    if (!transactionID) {
        return {
            success: false,
            error: submitBody.error || 'Relayer submit returned no transactionID',
        };
    }

    Logger.info(`   ⏳ Relayer tx queued: ${transactionID}`);
    const polled = await pollRelayerTx(transactionID);
    if (polled.state === 'TIMEOUT') {
        return {
            success: false,
            txId: transactionID,
            error: 'Relayer confirmation timed out',
        };
    }
    if (
        polled.state.includes('FAILED') ||
        polled.state.includes('INVALID') ||
        polled.state === 'STATE_FAILED' ||
        polled.state === 'STATE_INVALID'
    ) {
        return {
            success: false,
            txId: transactionID,
            txHash: polled.transactionHash,
            error: `Relayer tx ${polled.state}`,
        };
    }

    return {
        success: true,
        txId: transactionID,
        txHash: polled.transactionHash,
    };
};
