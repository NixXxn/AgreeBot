import { ethers } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';
import { createPolygonProvider } from './rpcProvider';

const RELAYER_URL = (process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com').replace(
    /\/$/,
    ''
);
const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const POLYGON_CHAIN_ID = 137;

const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
];

export interface WithdrawResult {
    success: boolean;
    txId?: string;
    txHash?: string;
    token?: string;
    error?: string;
}

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

const resolveCollateralToken = (): string => {
    try {
        return getContractConfig(POLYGON_CHAIN_ID).collateral;
    } catch {
        return ENV.USDC_CONTRACT_ADDRESS;
    }
};

/**
 * Pick the collateral token that actually holds funds on the funder.
 * Prefers CLOB v2 collateral (pUSD), falls back to USDC.e.
 */
export const resolveFundedCollateral = async (
    funder: string
): Promise<{ token: string; balanceRaw: ethers.BigNumber; decimals: number }> => {
    const provider = await createPolygonProvider();
    const candidates = Array.from(
        new Set(
            [resolveCollateralToken(), ENV.USDC_CONTRACT_ADDRESS].filter(Boolean).map((a) =>
                ethers.utils.getAddress(a)
            )
        )
    );

    let best: { token: string; balanceRaw: ethers.BigNumber; decimals: number } | null = null;

    for (const token of candidates) {
        try {
            const contract = new ethers.Contract(token, ERC20_ABI, provider);
            const [balanceRaw, decimalsRaw] = await Promise.all([
                contract.balanceOf(funder),
                contract.decimals().catch(() => 6),
            ]);
            const decimals = Number(decimalsRaw) || 6;
            if (!best || balanceRaw.gt(best.balanceRaw)) {
                best = { token, balanceRaw, decimals };
            }
        } catch (error) {
            Logger.warning(
                `Collateral balance check failed for ${token}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }

    if (!best) {
        throw new Error('Could not read collateral balance on funder');
    }
    return best;
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
 * Transfer collateral from deposit wallet (signature type 3) via gasless relayer batch.
 */
const withdrawViaDepositWallet = async (
    amountUsd: number,
    recipient: string
): Promise<WithdrawResult> => {
    if (!ENV.RELAYER_API_KEY || !ENV.RELAYER_API_KEY_ADDRESS) {
        return {
            success: false,
            error: 'RELAYER_API_KEY / RELAYER_API_KEY_ADDRESS required for deposit-wallet withdraw',
        };
    }

    const funder = ENV.PROXY_WALLET?.trim();
    if (!funder) {
        return { success: false, error: 'PROXY_WALLET / POLY_FUNDER not set' };
    }

    const pk = ENV.PRIVATE_KEY?.trim();
    if (!pk) {
        return { success: false, error: 'PRIVATE_KEY not set' };
    }

    const provider = await createPolygonProvider();
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`, provider);
    const { token, balanceRaw, decimals } = await resolveFundedCollateral(funder);
    const amountRaw = ethers.utils.parseUnits(amountUsd.toFixed(decimals), decimals);

    if (balanceRaw.lt(amountRaw)) {
        return {
            success: false,
            error: `On-chain collateral ${ethers.utils.formatUnits(
                balanceRaw,
                decimals
            )} < payout $${amountUsd}`,
            token,
        };
    }

    const iface = new ethers.utils.Interface(ERC20_ABI);
    const data = iface.encodeFunctionData('transfer', [recipient, amountRaw]);
    const calls = [
        {
            target: token as `0x${string}`,
            value: '0',
            data: data as `0x${string}`,
        },
    ];

    const paramsRes = await fetch(
        `${RELAYER_URL}/v1/account/transactions/params?address=${wallet.address}&type=WALLET`,
        { headers: relayerHeaders() }
    );
    if (!paramsRes.ok) {
        const text = await paramsRes.text();
        return { success: false, error: `Relayer params failed: ${paramsRes.status} ${text}`, token };
    }
    const paramsBody = (await paramsRes.json()) as { nonce?: string | number };
    const nonce = String(paramsBody.nonce ?? '');
    if (!nonce) {
        return { success: false, error: 'Relayer returned empty nonce', token };
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
        calls: calls.map((c) => ({
            target: c.target,
            value: c.value,
            data: c.data,
        })),
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
            metadata: `AgreeBot auto-claim $${amountUsd.toFixed(2)}`,
            depositWalletParams: {
                depositWallet: funder,
                deadline,
                calls,
            },
        }),
    });

    if (!submitRes.ok) {
        const text = await submitRes.text();
        return { success: false, error: `Relayer submit failed: ${submitRes.status} ${text}`, token };
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
            token,
        };
    }

    const polled = await pollRelayerTx(transactionID);
    if (polled.state === 'TIMEOUT') {
        return {
            success: false,
            txId: transactionID,
            error: 'Relayer confirmation timed out',
            token,
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
            token,
        };
    }

    return {
        success: true,
        txId: transactionID,
        txHash: polled.transactionHash,
        token,
    };
};

/**
 * Direct ERC-20 transfer when the trading wallet is the EOA itself.
 */
const withdrawViaEoa = async (amountUsd: number, recipient: string): Promise<WithdrawResult> => {
    const pk = ENV.PRIVATE_KEY?.trim();
    if (!pk) return { success: false, error: 'PRIVATE_KEY not set' };

    const provider = await createPolygonProvider();
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : `0x${pk}`, provider);
    const from = ENV.PROXY_WALLET?.trim() || wallet.address;

    if (from.toLowerCase() !== wallet.address.toLowerCase()) {
        return {
            success: false,
            error: 'EOA withdraw only works when PROXY_WALLET equals the signer',
        };
    }

    const { token, balanceRaw, decimals } = await resolveFundedCollateral(from);
    const amountRaw = ethers.utils.parseUnits(amountUsd.toFixed(decimals), decimals);
    if (balanceRaw.lt(amountRaw)) {
        return {
            success: false,
            token,
            error: `On-chain collateral ${ethers.utils.formatUnits(
                balanceRaw,
                decimals
            )} < payout $${amountUsd}`,
        };
    }

    const contract = new ethers.Contract(token, ERC20_ABI, wallet);
    const tx = await contract.transfer(recipient, amountRaw);
    const receipt = await tx.wait();
    return {
        success: receipt?.status === 1,
        txHash: tx.hash,
        token,
        error: receipt?.status === 1 ? undefined : 'Transfer tx reverted',
    };
};

/**
 * Pay out `amountUsd` of Polymarket collateral from the trading wallet to `recipient`.
 * Signature type 3 → gasless deposit-wallet batch; EOA → direct transfer.
 */
export const withdrawCollateralToWallet = async (
    amountUsd: number,
    recipient: string
): Promise<WithdrawResult> => {
    if (!(amountUsd > 0)) {
        return { success: false, error: 'amount must be > 0' };
    }
    if (!ethers.utils.isAddress(recipient)) {
        return { success: false, error: `Invalid recipient: ${recipient}` };
    }

    const sig = ENV.POLY_SIGNATURE_TYPE;
    if (sig === '3' || sig === '') {
        // Default path for deposit wallets; also try when auto-detect left type empty but funder ≠ EOA
        const result = await withdrawViaDepositWallet(amountUsd, recipient);
        if (result.success || sig === '3') return result;
        // Fall through to EOA if type unset and deposit path failed for missing relayer etc.
    }

    if (sig === '0' || !ENV.PROXY_WALLET?.trim()) {
        return withdrawViaEoa(amountUsd, recipient);
    }

    if (sig === '1' || sig === '2') {
        // Safe/Proxy gasless withdraw needs builder-relayer SAFE/PROXY execute —
        // deposit-wallet path won't work. Attempt deposit path only if misconfigured as 3.
        return {
            success: false,
            error: `Auto-claim withdraw for POLY_SIGNATURE_TYPE=${sig} needs Safe/Proxy relayer execute (not yet wired). Use type 3 or EOA.`,
        };
    }

    return withdrawViaDepositWallet(amountUsd, recipient);
};
