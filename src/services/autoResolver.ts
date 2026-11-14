import { AssetType, ClobClient, OrderType, Side } from '@polymarket/clob-client-v2';
import { ethers } from 'ethers';
import { ENV } from '../config/env';
import { fetchUserPositions } from '../utils/polymarketData';
import Logger from '../utils/logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const RPC_URL = ENV.RPC_URL;
const RETRY_LIMIT = ENV.RETRY_LIMIT;

// Auto-resolver configuration from ENV
const AUTO_RESOLVE_ENABLED = ENV.AUTO_RESOLVE_ENABLED;
const AUTO_RESOLVE_INTERVAL = ENV.AUTO_RESOLVE_INTERVAL;

// Contract addresses on Polygon
const CTF_CONTRACT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
/** Legacy Polymarket collateral (USDC.e) — many resolved CTF conditions still use this. */
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** Current CLOB v2 collateral (pUSD). */
const PUSD_ADDRESS = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';

// CTF Contract ABI (only the functions we need)
const CTF_ABI = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] calldata indexSets) external',
    'function balanceOf(address owner, uint256 tokenId) external view returns (uint256)',
];
const NEG_RISK_ABI = [
    'function redeemPositions(bytes32 _conditionId, uint256[] _amounts) external',
];

// Polymarket enforces a 1 token minimum on sell orders
const MIN_SELL_TOKENS = 1.0;
const ZERO_THRESHOLD = 0.0001;

// Thresholds for considering a position "resolved"
const RESOLVED_HIGH = 0.99; // Position won (price ~$1)
const RESOLVED_LOW = 0.01; // Position lost (price ~$0)

interface Position {
    asset: string;
    conditionId: string;
    size: number;
    avgPrice: number;
    currentValue: number;
    curPrice: number;
    title?: string;
    outcome?: string;
    slug?: string;
    redeemable?: boolean;
    negativeRisk?: boolean;
    outcomeIndex?: number;
}

interface ResolveResult {
    method: 'sell' | 'redeem' | 'failed';
    tokens: number;
    proceeds: number;
}

// Track if resolver should continue running
let isRunning = true;

// Lazy-initialized provider and contract
let provider: ethers.providers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;
let ctfContract: ethers.Contract | null = null;
let contractInit: Promise<void> | null = null;

const getContract = async () => {
    if (!provider || !wallet || !ctfContract) {
        if (!contractInit) {
            contractInit = (async () => {
                const { createPolygonProvider } = await import('../utils/rpcProvider');
                provider = await createPolygonProvider(RPC_URL);
                wallet = new ethers.Wallet(PRIVATE_KEY, provider);
                ctfContract = new ethers.Contract(CTF_CONTRACT_ADDRESS, CTF_ABI, wallet);
            })();
        }
        await contractInit;
    }
    return { provider: provider!, wallet: wallet!, ctfContract: ctfContract! };
};

/**
 * Stop the auto resolver gracefully
 */
export const stopAutoResolver = () => {
    isRunning = false;
    Logger.info('Auto resolver shutdown requested...');
};

const extractOrderError = (response: unknown): string | undefined => {
    if (!response) {
        return undefined;
    }

    if (typeof response === 'string') {
        return response;
    }

    if (typeof response === 'object') {
        const data = response as Record<string, unknown>;

        const directError = data.error;
        if (typeof directError === 'string') {
            return directError;
        }

        if (typeof directError === 'object' && directError !== null) {
            const nested = directError as Record<string, unknown>;
            if (typeof nested.error === 'string') {
                return nested.error;
            }
            if (typeof nested.message === 'string') {
                return nested.message;
            }
        }

        if (typeof data.errorMsg === 'string') {
            return data.errorMsg;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }
    }

    return undefined;
};

const isInsufficientBalanceOrAllowanceError = (message: string | undefined): boolean => {
    if (!message) {
        return false;
    }
    const lower = message.toLowerCase();
    return lower.includes('not enough balance') || lower.includes('allowance');
};

const updatePolymarketCache = async (clobClient: ClobClient, tokenId: string) => {
    try {
        await clobClient.updateBalanceAllowance({
            asset_type: AssetType.CONDITIONAL,
            token_id: tokenId,
        });
    } catch (error) {
        // Silently ignore cache update errors
    }
};

/**
 * Try to sell position via CLOB orderbook
 * Returns: tokens sold, proceeds, and whether orderbook was available
 */
const trySellPosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<{ sold: number; proceeds: number; orderbookAvailable: boolean }> => {
    let remaining = position.size;
    let attempts = 0;
    let soldTokens = 0;
    let proceedsUsd = 0;
    let orderbookAvailable = true;

    if (remaining < MIN_SELL_TOKENS) {
        return { sold: 0, proceeds: 0, orderbookAvailable: true };
    }

    await updatePolymarketCache(clobClient, position.asset);

    while (remaining >= MIN_SELL_TOKENS && attempts < RETRY_LIMIT) {
        let orderBook;
        try {
            orderBook = await clobClient.getOrderBook(position.asset);
        } catch (error) {
            // Orderbook doesn't exist - market is closed
            orderbookAvailable = false;
            break;
        }

        if (!orderBook.bids || orderBook.bids.length === 0) {
            orderbookAvailable = false;
            break;
        }

        const bestBid = orderBook.bids.reduce((max, bid) => {
            return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
        }, orderBook.bids[0]);

        const bidSize = parseFloat(bestBid.size);
        const bidPrice = parseFloat(bestBid.price);

        if (bidSize < MIN_SELL_TOKENS) {
            break;
        }

        const sellAmount = Math.min(remaining, bidSize);

        if (sellAmount < MIN_SELL_TOKENS) {
            break;
        }

        const orderArgs = {
            side: Side.SELL,
            tokenID: position.asset,
            amount: sellAmount,
            price: bidPrice,
        };

        try {
            const resp = await clobClient.createAndPostMarketOrder(
                orderArgs,
                undefined,
                OrderType.FOK
            );

            if (resp.success === true) {
                const tradeValue = sellAmount * bidPrice;
                soldTokens += sellAmount;
                proceedsUsd += tradeValue;
                remaining -= sellAmount;
                attempts = 0;
                Logger.success(
                    `   ✅ Sold ${sellAmount.toFixed(2)} tokens @ $${bidPrice.toFixed(3)} (≈ $${tradeValue.toFixed(2)})`
                );
            } else {
                attempts += 1;
                const errorMessage = extractOrderError(resp);

                if (isInsufficientBalanceOrAllowanceError(errorMessage)) {
                    break;
                }
            }
        } catch (error) {
            attempts += 1;
        }
    }

    return { sold: soldTokens, proceeds: proceedsUsd, orderbookAvailable };
};

const toConditionIdBytes32 = (conditionId: string): string =>
    ethers.utils.hexZeroPad(ethers.BigNumber.from(conditionId).toHexString(), 32);

const encodeCtfRedeem = (collateralToken: string, conditionIdBytes32: string): string => {
    const iface = new ethers.utils.Interface(CTF_ABI);
    return iface.encodeFunctionData('redeemPositions', [
        collateralToken,
        ethers.constants.HashZero,
        conditionIdBytes32,
        [1, 2],
    ]);
};

const encodeNegRiskRedeem = (
    conditionIdBytes32: string,
    size: number,
    outcomeIndex?: number
): string => {
    const iface = new ethers.utils.Interface(NEG_RISK_ABI);
    // Amounts are [YES, NO] in token base units (6 decimals)
    const raw = ethers.utils.parseUnits(Math.max(size, 0).toFixed(6), 6);
    const amounts =
        outcomeIndex === 1
            ? [ethers.constants.Zero, raw]
            : [raw, ethers.constants.Zero];
    return iface.encodeFunctionData('redeemPositions', [conditionIdBytes32, amounts]);
};

/**
 * Gasless redeem via Polymarket Relayer (deposit wallet WALLET batch).
 * @see https://docs.polymarket.com/trading/wallets-auth#execute-gasless-transactions
 */
const redeemViaRelayer = async (
    position: Position
): Promise<{ success: boolean; error?: string; txHash?: string }> => {
    const { executeDepositWalletBatch, shouldUseGaslessRelayer } = await import(
        '../utils/relayerWallet'
    );
    if (!shouldUseGaslessRelayer()) {
        return { success: false, error: 'Relayer creds / deposit wallet not configured' };
    }

    const conditionIdBytes32 = toConditionIdBytes32(position.conditionId);

    if (position.negativeRisk) {
        Logger.info(`   🔗 Gasless redeem via Relayer (NegRisk)...`);
        const data = encodeNegRiskRedeem(
            conditionIdBytes32,
            position.size,
            position.outcomeIndex
        );
        const result = await executeDepositWalletBatch(
            [{ target: NEG_RISK_ADAPTER_ADDRESS, value: '0', data }],
            `AgreeBot redeem neg-risk ${position.slug || position.conditionId.slice(0, 10)}`
        );
        if (result.success) {
            Logger.success(
                `   ✅ Redeemed gaslessly via Relayer` +
                    (result.txHash ? ` tx=${result.txHash}` : result.txId ? ` id=${result.txId}` : '')
            );
            return { success: true, txHash: result.txHash };
        }
        return { success: false, error: result.error };
    }

    // Try USDC.e first (legacy CTF conditions), then pUSD
    const collaterals = [USDC_E_ADDRESS, PUSD_ADDRESS];
    let lastError = 'unknown';
    for (const collateral of collaterals) {
        Logger.info(
            `   🔗 Gasless redeem via Relayer (CTF collateral ${collateral.slice(0, 8)}…)…`
        );
        const data = encodeCtfRedeem(collateral, conditionIdBytes32);
        const result = await executeDepositWalletBatch(
            [{ target: CTF_CONTRACT_ADDRESS, value: '0', data }],
            `AgreeBot redeem ${position.slug || position.conditionId.slice(0, 10)}`
        );
        if (result.success) {
            Logger.success(
                `   ✅ Redeemed gaslessly via Relayer` +
                    (result.txHash ? ` tx=${result.txHash}` : result.txId ? ` id=${result.txId}` : '')
            );
            return { success: true, txHash: result.txHash };
        }
        lastError = result.error || lastError;
        Logger.warning(`   Relayer redeem with ${collateral.slice(0, 8)}… failed: ${lastError}`);
    }
    return { success: false, error: lastError };
};

/**
 * Redeem position — prefer Polymarket Relayer (gasless), fall back to EOA-paid CTF tx.
 */
const redeemPosition = async (position: Position): Promise<{ success: boolean; error?: string }> => {
    try {
        const { shouldUseGaslessRelayer } = await import('../utils/relayerWallet');
        if (shouldUseGaslessRelayer()) {
            const gasless = await redeemViaRelayer(position);
            if (gasless.success) return { success: true };
            Logger.warning(
                `   Relayer redeem failed (${gasless.error}) — trying direct EOA redeem (needs POL)`
            );
        } else {
            Logger.info(`   🔗 Attempting on-chain redemption (EOA / needs POL for gas)...`);
        }

        const { ctfContract, provider } = await getContract();
        const conditionIdBytes32 = toConditionIdBytes32(position.conditionId);

        const feeData = await provider!.getFeeData();
        const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
        if (!gasPrice) {
            throw new Error('Could not determine gas price');
        }
        const adjustedGasPrice = gasPrice.mul(120).div(100);

        // Prefer USDC.e for legacy conditions; pUSD for newer CLOB v2 markets
        const collateral = ENV.USDC_CONTRACT_ADDRESS || USDC_E_ADDRESS;
        const tx = await ctfContract.redeemPositions(
            collateral,
            ethers.constants.HashZero,
            conditionIdBytes32,
            [1, 2],
            {
                gasLimit: 500000,
                gasPrice: adjustedGasPrice,
            }
        );

        Logger.info(`   ⏳ TX submitted: ${tx.hash}`);

        const { waitForTxReceipt } = await import('../utils/rpcProvider');
        const receipt = await waitForTxReceipt(provider!, tx.hash);

        if (receipt.status === 1) {
            const gasCost = ethers.utils.formatUnits(
                receipt.gasUsed.mul(adjustedGasPrice),
                18
            );
            Logger.success(`   ✅ Redeemed on-chain! Gas: ${parseFloat(gasCost).toFixed(6)} POL`);
            return { success: true };
        }
        return { success: false, error: 'Transaction reverted' };
    } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMessage };
    }
};

const loadPositions = async (address: string): Promise<Position[]> => {
    const data = await fetchUserPositions(address);
    const positions: Position[] = data.map((pos) => ({
        asset: pos.asset,
        conditionId: pos.conditionId,
        size: pos.size,
        avgPrice: pos.avgPrice,
        currentValue: pos.currentValue,
        curPrice: pos.curPrice,
        title: pos.title,
        outcome: pos.outcome,
        slug: pos.slug,
        redeemable: pos.redeemable,
        negativeRisk: pos.negativeRisk,
        outcomeIndex: pos.outcomeIndex,
    }));
    return positions.filter((pos) => (pos.size || 0) > ZERO_THRESHOLD);
};

/**
 * Resolve a single position - try sell first, fallback to redeem
 */
const resolvePosition = async (
    clobClient: ClobClient,
    position: Position
): Promise<ResolveResult> => {
    const isWin = position.curPrice >= RESOLVED_HIGH;

    // First, try to sell via CLOB
    const sellResult = await trySellPosition(clobClient, position);

    if (sellResult.sold > 0) {
        return { method: 'sell', tokens: sellResult.sold, proceeds: sellResult.proceeds };
    }

    // If orderbook not available and position is redeemable, try on-chain redeem
    if (!sellResult.orderbookAvailable && position.redeemable) {
        Logger.info(`   📦 Orderbook closed, trying redeem (Relayer gasless if configured)...`);

        const redeemResult = await redeemPosition(position);

        if (redeemResult.success) {
            // For wins, proceeds = token amount (each token redeems for $1)
            // For losses, proceeds = 0
            const proceeds = isWin ? position.size : 0;
            return { method: 'redeem', tokens: position.size, proceeds };
        } else {
            Logger.error(`   ❌ Redeem failed: ${redeemResult.error}`);
        }
    } else if (!sellResult.orderbookAvailable && !position.redeemable) {
        Logger.warning(`   ⏳ Orderbook closed but market not yet redeemable`);
    }

    return { method: 'failed', tokens: 0, proceeds: 0 };
};

const checkAndResolvePositions = async (clobClient: ClobClient): Promise<void> => {
    const allPositions = await loadPositions(PROXY_WALLET);

    if (allPositions.length === 0) {
        return;
    }

    // Filter for resolved positions (price >= 99% or <= 1%)
    const resolvedPositions = allPositions.filter(
        (pos) => pos.curPrice >= RESOLVED_HIGH || pos.curPrice <= RESOLVED_LOW
    );

    if (resolvedPositions.length === 0) {
        return;
    }

    Logger.header(`🔄 AUTO-RESOLVE: Found ${resolvedPositions.length} resolved position(s)`);

    let totalSold = 0;
    let totalRedeemed = 0;
    let totalProceeds = 0;

    // Group positions by conditionId for redeem (redeem handles all outcomes at once)
    const processedConditions = new Set<string>();

    for (const position of resolvedPositions) {
        const status = position.curPrice >= RESOLVED_HIGH ? '🎉 WIN' : '❌ LOSS';
        Logger.info(`${status} | ${position.title || position.slug || position.asset}`);
        if (position.outcome) {
            Logger.info(`   Outcome: ${position.outcome}`);
        }
        Logger.info(
            `   Size: ${position.size.toFixed(2)} tokens @ avg $${position.avgPrice.toFixed(3)}`
        );
        Logger.info(
            `   Price: $${position.curPrice.toFixed(4)} | Value: $${position.currentValue.toFixed(2)} | Redeemable: ${position.redeemable ? 'Yes' : 'No'}`
        );

        // Skip if we already redeemed this condition
        if (processedConditions.has(position.conditionId)) {
            Logger.info(`   ⏭️  Already processed this condition`);
            continue;
        }

        try {
            const result = await resolvePosition(clobClient, position);

            if (result.method === 'sell') {
                totalSold += result.tokens;
                totalProceeds += result.proceeds;
            } else if (result.method === 'redeem') {
                totalRedeemed += result.tokens;
                totalProceeds += result.proceeds;
                processedConditions.add(position.conditionId);
            }
        } catch (error) {
            Logger.error(`   ❌ Failed to resolve: ${error}`);
        }
    }

    if (totalSold > 0 || totalRedeemed > 0) {
        Logger.success(`AUTO-RESOLVE Complete:`);
        if (totalSold > 0) {
            Logger.info(`   Sold via CLOB: ${totalSold.toFixed(2)} tokens`);
        }
        if (totalRedeemed > 0) {
            Logger.info(`   Redeemed on-chain: ${totalRedeemed.toFixed(2)} tokens`);
        }
        Logger.info(`   Total proceeds: ~$${totalProceeds.toFixed(2)}`);

        // Cash just increased — check doubling ladder immediately
        try {
            const { runAutoClaimOnce } = await import('./autoClaim');
            await runAutoClaimOnce();
        } catch (error) {
            Logger.warning(
                `Post-resolve auto claim skipped: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
    Logger.separator();
};

const autoResolver = async () => {
    if (!AUTO_RESOLVE_ENABLED) {
        Logger.info('Auto resolver is disabled');
        return;
    }

    Logger.success(`Auto resolver started (checking every ${AUTO_RESOLVE_INTERVAL}s)`);
    Logger.info(`   Thresholds: WIN >= $${RESOLVED_HIGH}, LOSS <= $${RESOLVED_LOW}`);
    Logger.info(`   Fallback: On-chain redeem if orderbook closed`);

    while (isRunning) {
        try {
            const { ENV } = await import('../config/env');
            if (ENV.PAPER_MODE) {
                // Live-only; wait until mode flips
            } else {
                const { ensureClobClient } = await import('./clobClientHolder');
                const clobClient = await ensureClobClient();
                if (clobClient) {
                    await checkAndResolvePositions(clobClient);
                }
            }
        } catch (error) {
            Logger.error(`Auto resolver error: ${error}`);
        }

        if (!isRunning) break;
        await new Promise((resolve) => setTimeout(resolve, AUTO_RESOLVE_INTERVAL * 1000));
    }

    Logger.info('Auto resolver stopped');
};

export default autoResolver;
