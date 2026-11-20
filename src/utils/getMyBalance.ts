import { ethers } from 'ethers';
import { AssetType } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import { createPolygonProvider } from './rpcProvider';
import Logger from './logger';

const USDC_CONTRACT_ADDRESS = ENV.USDC_CONTRACT_ADDRESS;
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

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
 * Polymarket trading balance (CLOB collateral) via the shared live CLOB client.
 * Returns null in paper mode or when the client is unavailable.
 */
export const getClobCollateralBalance = async (): Promise<number | null> => {
    if (ENV.PAPER_MODE) return null;
    if (!ENV.PRIVATE_KEY?.trim() || !ENV.PROXY_WALLET?.trim()) return null;

    try {
        const { ensureClobClient } = await import('../services/clobClientHolder');
        const clob = await ensureClobClient();
        if (!clob) return null;

        const params = { asset_type: AssetType.COLLATERAL } as const;
        try {
            await clob.updateBalanceAllowance(params);
        } catch {
            /* cache refresh is best-effort */
        }

        const response: { balance?: string; error?: string } =
            await clob.getBalanceAllowance(params);

        if (response && typeof response === 'object' && 'error' in response && response.error) {
            Logger.warning(`CLOB balance error: ${response.error}`);
            return null;
        }

        return parseClobAmount(response?.balance);
    } catch (error) {
        Logger.warning(
            `CLOB balance fetch failed: ${error instanceof Error ? error.message : String(error)}`
        );
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
