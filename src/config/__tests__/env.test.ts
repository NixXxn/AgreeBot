/**
 * Tests for environment variable parsing and validation
 * Note: These tests require mocking process.env
 */

describe('Environment variable parsing', () => {
    const originalEnv = process.env;

    const setLiveBase = () => {
        process.env.PROXY_WALLET = '0x1111111111111111111111111111111111111111';
        process.env.PRIVATE_KEY = 'testkey';
        process.env.CLOB_HTTP_URL = 'https://clob.polymarket.com/';
        process.env.CLOB_WS_URL = 'wss://ws.polymarket.com/ws';
        process.env.MONGO_URI = 'mongodb://localhost:27017/test';
        process.env.RPC_URL = 'https://polygon-rpc.com';
        process.env.USDC_CONTRACT_ADDRESS = '0x2222222222222222222222222222222222222222';
        // Prevent dotenv/.env from filling aliases
        process.env.POLY_FUNDER = '';
        process.env.POLY_PRIVATE_KEY = '';
        process.env.PAPER_MODE = 'false';
        process.env.PREVIEW_MODE = 'false';
    };

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('should soft-parse optional legacy USER_ADDRESSES (not required)', () => {
        setLiveBase();
        process.env.USER_ADDRESSES =
            '0x1234567890123456789012345678901234567890, 0x0987654321098765432109876543210987654321';

        const { ENV } = require('../env');
        expect(ENV.USER_ADDRESSES).toHaveLength(2);
        expect(ENV.USER_ADDRESSES[0]).toBe('0x1234567890123456789012345678901234567890');
    });

    it('should allow empty USER_ADDRESSES (dashboard owns traders)', () => {
        setLiveBase();
        // Empty string wins over dotenv so .env cannot resurrect traders
        process.env.USER_ADDRESSES = '';

        const { ENV } = require('../env');
        expect(ENV.USER_ADDRESSES).toEqual([]);
    });

    it('should skip invalid addresses in legacy USER_ADDRESSES instead of throwing', () => {
        setLiveBase();
        process.env.USER_ADDRESSES =
            'invalid-address,0x1234567890123456789012345678901234567890';

        const { ENV } = require('../env');
        expect(ENV.USER_ADDRESSES).toEqual(['0x1234567890123456789012345678901234567890']);
    });

    it('should reject invalid FETCH_INTERVAL', () => {
        setLiveBase();
        process.env.USER_ADDRESSES = '';
        process.env.FETCH_INTERVAL = '-1';

        expect(() => {
            require('../env');
        }).toThrow('Invalid FETCH_INTERVAL');
    });

    it('should allow missing wallet credentials in PAPER_MODE without traders in env', () => {
        process.env.PAPER_MODE = 'true';
        process.env.PREVIEW_MODE = 'true';
        process.env.USER_ADDRESSES = '';
        process.env.MONGO_URI = 'mongodb://localhost:27017/test';
        process.env.PROXY_WALLET = '';
        process.env.PRIVATE_KEY = '';
        process.env.POLY_FUNDER = '';
        process.env.POLY_PRIVATE_KEY = '';
        process.env.RPC_URL = '';

        const { ENV } = require('../env');
        expect(ENV.PAPER_MODE).toBe(true);
        expect(ENV.PREVIEW_MODE).toBe(true);
        expect(ENV.PROXY_WALLET).toBe('');
        expect(ENV.USER_ADDRESSES).toEqual([]);
    });

    it('should require wallet when not in paper mode', () => {
        process.env.PAPER_MODE = 'false';
        process.env.PREVIEW_MODE = 'false';
        process.env.USER_ADDRESSES = '';
        process.env.MONGO_URI = 'mongodb://localhost:27017/test';
        process.env.PROXY_WALLET = '';
        process.env.PRIVATE_KEY = '';
        process.env.POLY_FUNDER = '';
        process.env.POLY_PRIVATE_KEY = '';
        process.env.CLOB_HTTP_URL = 'https://clob.polymarket.com/';
        process.env.CLOB_WS_URL = 'wss://ws.polymarket.com/ws';
        process.env.RPC_URL = 'https://polygon-rpc.com';
        process.env.USDC_CONTRACT_ADDRESS = '0x2222222222222222222222222222222222222222';

        expect(() => {
            require('../env');
        }).toThrow(/PROXY_WALLET|PRIVATE_KEY/);
    });
});
