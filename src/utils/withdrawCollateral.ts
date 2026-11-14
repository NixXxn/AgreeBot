import { ethers } from 'ethers';
import { getContractConfig } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';
import { createPolygonProvider } from './rpcProvider';
import { executeDepositWalletBatch, shouldUseGaslessRelayer } from './relayerWallet';

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

/**
 * Transfer collateral from deposit wallet (signature type 3) via gasless relayer batch.
 */
const withdrawViaDepositWallet = async (
    amountUsd: number,
    recipient: string
): Promise<WithdrawResult> => {
    const funder = ENV.PROXY_WALLET?.trim();
    if (!funder) {
        return { success: false, error: 'PROXY_WALLET / POLY_FUNDER not set' };
    }

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
    const result = await executeDepositWalletBatch(
        [{ target: token, value: '0', data }],
        `AgreeBot auto-claim $${amountUsd.toFixed(2)}`
    );

    return { ...result, token };
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
    if (shouldUseGaslessRelayer() || sig === '3') {
        const result = await withdrawViaDepositWallet(amountUsd, recipient);
        if (result.success || sig === '3') return result;
    }

    if (sig === '0' || !ENV.PROXY_WALLET?.trim()) {
        return withdrawViaEoa(amountUsd, recipient);
    }

    if (sig === '1' || sig === '2') {
        return {
            success: false,
            error: `Auto-claim withdraw for POLY_SIGNATURE_TYPE=${sig} needs Safe/Proxy relayer execute (not yet wired). Use type 3 or EOA.`,
        };
    }

    return withdrawViaDepositWallet(amountUsd, recipient);
};
