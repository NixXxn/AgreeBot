import { ethers } from 'ethers';
import { Chain, ClobClient, SignatureTypeV2 } from '@polymarket/clob-client-v2';
import { ENV } from '../config/env';
import Logger from './logger';
import { createPolygonProvider } from './rpcProvider';

const PROXY_WALLET = ENV.PROXY_WALLET;
const PRIVATE_KEY = ENV.PRIVATE_KEY;
const CLOB_HTTP_URL = ENV.CLOB_HTTP_URL;

/**
 * Determines if a wallet is a Gnosis Safe by checking if it has contract code
 */
const isGnosisSafe = async (address: string): Promise<boolean> => {
    try {
        const provider = await createPolygonProvider();
        const code = await provider.getCode(address);
        return code !== '0x';
    } catch (error) {
        Logger.error(`Error checking wallet type: ${error}`);
        return false;
    }
};

const resolveSignatureType = async (): Promise<{
    signatureType: SignatureTypeV2;
    label: string;
    funder?: string;
}> => {
    const funder = PROXY_WALLET?.trim() || undefined;
    const raw = ENV.POLY_SIGNATURE_TYPE;
    if (raw !== '') {
        const n = parseInt(raw, 10);
        if (n === 0) return { signatureType: SignatureTypeV2.EOA, label: 'EOA (0)', funder };
        if (n === 1)
            return { signatureType: SignatureTypeV2.POLY_PROXY, label: 'POLY_PROXY (1)', funder };
        if (n === 2)
            return {
                signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
                label: 'POLY_GNOSIS_SAFE (2)',
                funder,
            };
        if (n === 3)
            return { signatureType: SignatureTypeV2.POLY_1271, label: 'POLY_1271 (3)', funder };
        Logger.warning(`Unknown POLY_SIGNATURE_TYPE=${raw} — falling back to auto-detect`);
    }

    if (!funder) {
        return { signatureType: SignatureTypeV2.EOA, label: 'EOA (auto, no funder)' };
    }

    const isProxySafe = await isGnosisSafe(funder);
    if (isProxySafe) {
        return {
            signatureType: SignatureTypeV2.POLY_GNOSIS_SAFE,
            label: 'POLY_GNOSIS_SAFE (auto)',
            funder,
        };
    }
    // Polymarket proxy / deposit wallets are often EOAs with code 0x — default PROXY when funder set
    return {
        signatureType: SignatureTypeV2.POLY_PROXY,
        label: 'POLY_PROXY (auto)',
        funder,
    };
};

const createClobClient = async (): Promise<ClobClient> => {
    const host = (CLOB_HTTP_URL as string).replace(/\/$/, '');
    const wallet = new ethers.Wallet(PRIVATE_KEY as string);
    const { signatureType, label, funder } = await resolveSignatureType();

    Logger.info(`CLOB wallet signature type: ${label}${funder ? ` funder=${funder}` : ''}`);

    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    console.log = function () {};
    console.error = function () {};

    let creds;
    try {
        const bootstrap = new ClobClient({
            host,
            chain: Chain.POLYGON,
            signer: wallet,
            signatureType,
            funderAddress: funder,
        });
        creds = await bootstrap.createOrDeriveApiKey();
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
    }

    const clobClient = new ClobClient({
        host,
        chain: Chain.POLYGON,
        signer: wallet,
        creds,
        signatureType,
        funderAddress: funder,
        useServerTime: true,
        retryOnError: true,
    });

    // Adopt server order version (CLOB v2+) so posts aren't rejected as "invalid order version"
    try {
        const version = await clobClient.getVersion();
        Logger.info(`CLOB order protocol version: ${version}`);
    } catch (error) {
        Logger.warning(
            `Could not fetch CLOB order version (will recover on first post): ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }

    return clobClient;
};

export default createClobClient;
