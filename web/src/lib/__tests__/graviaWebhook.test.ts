import { createHmac } from 'crypto';
import {
  isGraviaTestEvent,
  isGraviaTradeEvent,
  mapGraviaTradeToActivity,
  verifyGraviaSignature,
} from '../graviaWebhook';

describe('graviaWebhook', () => {
  const secret = 'test-signing-secret';

  it('verifies HMAC signatures over raw body', () => {
    const body = Buffer.from('{"id":"abc","event":"trader_new_trade"}', 'utf8');
    const sig =
      'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyGraviaSignature(body, sig, secret)).toBe(true);
    expect(verifyGraviaSignature(body, sig + 'x', secret)).toBe(false);
    expect(verifyGraviaSignature(body, null, secret)).toBe(false);
  });

  it('detects trade vs test events', () => {
    expect(isGraviaTradeEvent('trader_new_trade')).toBe(true);
    expect(isGraviaTradeEvent('trader_new_trade_test')).toBe(true);
    expect(isGraviaTestEvent('trader_new_trade_test')).toBe(true);
    expect(isGraviaTestEvent('trader_new_trade')).toBe(false);
  });

  it('maps Gravia trade payloads to activity docs', () => {
    const activity = mapGraviaTradeToActivity(
      {
        trader: '0x1111111111111111111111111111111111111111',
        position_id: '1234567890',
        condition_id: '0xabc',
        hash: '0xdeadbeef',
        side: 'Buy',
        price: 0.55,
        amount_usd: 100,
        shares_amount: 181.818,
        confirmed_at: 1700000000,
        outcome: 'Yes',
        event_slug: 'example-event',
      },
      'delivery-1'
    );
    expect(activity).not.toBeNull();
    expect(activity!.proxyWallet).toBe('0x1111111111111111111111111111111111111111');
    expect(activity!.asset).toBe('1234567890');
    expect(activity!.side).toBe('BUY');
    expect(activity!.usdcSize).toBe(100);
    expect(activity!.transactionHash).toBe('0xdeadbeef');
    expect(activity!.bot).toBe(false);
    expect(activity!.source).toBe('gravia');
  });

  it('rejects incomplete payloads', () => {
    expect(mapGraviaTradeToActivity({ trader: '0x1' })).toBeNull();
  });
});
