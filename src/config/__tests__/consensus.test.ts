/**
 * Unit tests for consensus keying and sizing helpers.
 * Buffer evaluation is covered via the exported pure helpers.
 */

import mongoose from 'mongoose';

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        header: jest.fn(),
    },
}));

jest.mock('../../models/userHistory', () => ({
    getUserActivityModel: jest.fn(() => ({
        updateOne: jest.fn(() => ({ exec: jest.fn() })),
    })),
}));

describe('Consensus helpers', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = {
            ...originalEnv,
            USER_ADDRESSES: '0x1234567890123456789012345678901234567890,0x0987654321098765432109876543210987654321',
            PROXY_WALLET: '0x1111111111111111111111111111111111111111',
            PRIVATE_KEY: 'testkey',
            CLOB_HTTP_URL: 'https://clob.polymarket.com/',
            CLOB_WS_URL: 'wss://ws.polymarket.com/ws',
            MONGO_URI: 'mongodb://localhost:27017/test',
            RPC_URL: 'https://polygon-rpc.com',
            USDC_CONTRACT_ADDRESS: '0x2222222222222222222222222222222222222222',
            CONSENSUS_ENABLED: 'true',
            CONSENSUS_MIN_AGREEMENT: '2',
            CONSENSUS_WINDOW_SECONDS: '60',
            CONSENSUS_APPLY_TO: 'BUY',
            CONSENSUS_SIZE_MODE: 'AVERAGE',
        };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    const makeTrade = (overrides: Record<string, unknown> = {}) => ({
        _id: new mongoose.Types.ObjectId(),
        proxyWallet: '0xabc',
        timestamp: Date.now(),
        conditionId: 'cond-1',
        type: 'TRADE',
        size: 10,
        usdcSize: 50,
        transactionHash: '0xhash',
        price: 0.5,
        asset: 'asset-yes',
        side: 'BUY',
        outcomeIndex: 0,
        title: 'Test',
        slug: 'test-market',
        icon: '',
        eventSlug: 'test-event',
        outcome: 'Yes',
        name: '',
        pseudonym: '',
        bio: '',
        profileImage: '',
        profileImageOptimized: '',
        bot: false,
        botExcutedTime: 0,
        userAddress: '0x1234567890123456789012345678901234567890',
        ...overrides,
    });

    it('builds the same consensus key for identical market+outcome+side', () => {
        const { getConsensusKey } = require('../../services/consensus');
        const a = makeTrade();
        const b = makeTrade({
            userAddress: '0x0987654321098765432109876543210987654321',
            usdcSize: 80,
        });
        expect(getConsensusKey(a)).toBe(getConsensusKey(b));
    });

    it('uses different keys for opposite outcomes', () => {
        const { getConsensusKey } = require('../../services/consensus');
        const yes = makeTrade({ asset: 'asset-yes', outcome: 'Yes' });
        const no = makeTrade({ asset: 'asset-no', outcome: 'No' });
        expect(getConsensusKey(yes)).not.toBe(getConsensusKey(no));
    });

    it('shouldUseConsensus respects APPLY_TO=BUY', () => {
        const { shouldUseConsensus } = require('../../services/consensus');
        expect(shouldUseConsensus('BUY')).toBe(true);
        expect(shouldUseConsensus('SELL')).toBe(false);
    });

    it('parses consensus env vars', () => {
        const { ENV } = require('../env');
        expect(ENV.CONSENSUS_ENABLED).toBe(true);
        expect(ENV.CONSENSUS_MIN_AGREEMENT).toBe(2);
        expect(ENV.CONSENSUS_WINDOW_SECONDS).toBe(60);
        expect(ENV.CONSENSUS_APPLY_TO).toBe('BUY');
        expect(ENV.CONSENSUS_SIZE_MODE).toBe('AVERAGE');
    });

    it('rejects invalid CONSENSUS_MIN_AGREEMENT', () => {
        process.env.CONSENSUS_MIN_AGREEMENT = '0';
        expect(() => {
            require('../env');
        }).toThrow('Invalid CONSENSUS_MIN_AGREEMENT');
    });
});
