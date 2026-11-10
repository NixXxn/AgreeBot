import { ethers } from 'ethers';
import { AssetType, ClobClient } from '@polymarket/clob-client';
import { ENV } from '../config/env';
import { createPolygonProvider } from './rpcProvider';
import Logger from './logger';

const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

let cachedClob: ClobClient | null = null;
let clobInit: Promise<ClobClient> | null = null;

const parseClobAmount = (raw: string | undefined): number | null => {
    if (raw === undefined || raw === null || raw === '') return null;
    try {
        return parseFloat(ethers.utils.formatUnits(raw, 6));
    } catch {
        const n = parseFloat(raw);
        return Number.isFinite(n) ? n : null;
    }
};

/**
 * Polymarket trading balance (CLOB collateral) — this is what signature-type-3
 * deposit wallets actually fund. Wallet ERC-20 USDC is often $0.
 */
const getClobCollateralBalance = async (): Promise<number | null> => {
    if (ENV.PAPER_MODE || !ENV.PRIVATE_KEY?.trim()) return null;

    try {
        if (!cachedClob) {
            if (!clobInit) {
                clobInit = (async () => {
                    const createClobClient = (await import('./createClobClient')).default;
                    return createClobClient();
                })();
            }
            cachedClob = await clobInit;
        }

        const params = { asset_type: AssetType.COLLATERAL } as const;
        try {
            await cachedClob.updateBalanceAllowance(params);
        } catch {
            /* cache refresh is best-effort */
        }

        const response: { balance?: string; error?: string } =
            await cachedClob.getBalanceAllowance(params);

        if (response && typeof response === 'object' && 'error' in response && response.error) {
            Logger.warning(`CLOB balance error: ${response.error}`);
            return null;
        }

        return parseClobAmount(response?.balance);
    } catch (error) {
        Logger.warning(
            `CLOB balance fetch failed: ${error instanceof Error ? error.message : String(error)}`
        );
        cachedClob = null;
        clobInit = null;
        return null;
    }
};

const getOnChainUsdcBalance = async (address: string): Promise<number> => {
    const rpcProvider = await createPolygonProvider();
    const usdcContract = new ethers.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, rpcProvider);
    const balance_usdc = await usdcContract.balanceOf(address);
    return parseFloat(ethers.utils.formatUnits(balance_usdc, 6));
};

/**
 * Prefer Polymarket CLOB collateral (tradeable cash). Fall back to on-chain USDC.e.
 */
const getMyBalance = async (address: string): Promise<number> => {
    const clob = await getClobCollateralBalance();
    if (clob !== null) return clob;

    if (!address) return 0;
    return getOnChainUsdcBalance(address);
};

export default getMyBalance;
