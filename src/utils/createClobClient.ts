import { ethers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import { SignatureType } from '@polymarket/order-utils';
import { ENV } from '../config/env';
import Logger from './logger';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;
const RPC_URL = ENV.RPC_URL;

/** POLY_1271 deposit wallets use signature type 3 (not yet in order-utils enum). */
const POLY_1271 = 3 as SignatureType;

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const resolveSignatureType = async (): Promise<{
    signatureType: SignatureType;
    label: string;
    funder?: string;
}> => {
    const funder = PROXY_WALLET?.trim() || undefined;
    const raw = ENV.POLY_SIGNATURE_TYPE;
    if (raw !== '') {
        const n = parseInt(raw, 10);
        if (n === 0) return { signatureType: SignatureType.EOA, label: 'EOA (0)', funder };
        if (n === 1)
            return { signatureType: SignatureType.POLY_PROXY, label: 'POLY_PROXY (1)', funder };
        if (n === 2)
            return {
                signatureType: SignatureType.POLY_GNOSIS_SAFE,
                label: 'POLY_GNOSIS_SAFE (2)',
                funder,
            };
        if (n === 3) return { signatureType: POLY_1271, label: 'POLY_1271 (3)', funder };
        Logger.warning(`Unknown POLY_SIGNATURE_TYPE=${raw} — falling back to auto-detect`);
    }

    if (!funder) {
        return { signatureType: SignatureType.EOA, label: 'EOA (auto, no funder)' };
    }

    const isProxySafe = await isGnosisSafe(funder);
    if (isProxySafe) {
        return {
            signatureType: SignatureType.POLY_GNOSIS_SAFE,
            label: 'POLY_GNOSIS_SAFE (auto)',
            funder,
        };
    }
    // Polymarket proxy / deposit wallets are often EOAs with code 0x — default PROXY when funder set
    return {
        signatureType: SignatureType.POLY_PROXY,
        label: 'POLY_PROXY (auto)',
        funder,
    };
};

const createClobClient = async (): Promise<ClobClient> => {
    const chainId = 137;
    const host = CLOB_HTTP_URL as string;
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);
    const { signatureType, label, funder } = await resolveSignatureType();

    Logger.info(`CLOB wallet signature type: ${label}${funder ? ` funder=${funder}` : ''}`);

    let clobClient = new ClobClient(
        host,
        chainId,
        wallet,
        undefined,
        signatureType,
        funder
    );

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    let creds = await clobClient.createApiKey();
    if (!creds.key) {
        creds = await clobClient.deriveApiKey();
    }

    clobClient = new ClobClient(host, chainId, wallet, creds, signatureType, funder);

    console.log = originalConsoleLog;
    console.error = originalConsoleError;

    return clobClient;
};

export default createClobClient;
