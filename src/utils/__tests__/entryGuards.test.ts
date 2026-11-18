import {
    eventFamilyKey,
    findEventFamilyPosition,
    findSameAssetPosition,
    isAverageDown,
    isCryptoUpDownMarket,
} from '../entryGuards';

describe('isCryptoUpDownMarket', () => {
    it('detects polymarket up-or-down slugs', () => {
        expect(
            isCryptoUpDownMarket({ slug: 'bitcoin-up-or-down-on-november-17-2026' })
        ).toBe(true);
        expect(
            isCryptoUpDownMarket({
                title: 'Solana Up or Down - November 17, 4:20AM-4:25AM ET',
            })
        ).toBe(true);
    });

    it('ignores normal sports', () => {
        expect(isCryptoUpDownMarket({ slug: 'nba-cha-lal-2026-11-17' })).toBe(false);
    });
});

describe('isAverageDown', () => {
    it('flags buys below held average', () => {
        expect(isAverageDown(0.8, 0.65)).toBe(true);
        expect(isAverageDown(0.8, 0.8)).toBe(false);
        expect(isAverageDown(0.8, 0.85)).toBe(false);
    });
});

describe('eventFamilyKey', () => {
    it('prefers eventSlug and strips game suffixes from slug', () => {
        expect(eventFamilyKey({ eventSlug: 'dota2-lgd-legion' })).toBe(
            'event:dota2-lgd-legion'
        );
        expect(eventFamilyKey({ slug: 'dota2-lgd-legion1-2026-11-17-game1' })).toBe(
            'slug:dota2-lgd-legion1-2026-11-17'
        );
    });
});

describe('findEventFamilyPosition', () => {
    it('finds other instrument in same event', () => {
        const held = findEventFamilyPosition(
            [
                {
                    asset: 'tok-a',
                    conditionId: 'c1',
                    eventSlug: 'match-1',
                    size: 10,
                    avgPrice: 0.5,
                },
            ],
            { asset: 'tok-b', conditionId: 'c2', eventSlug: 'match-1' }
        );
        expect(held?.conditionId).toBe('c1');
    });

    it('ignores same asset (average-down handles that)', () => {
        const held = findEventFamilyPosition(
            [{ asset: 'tok-a', conditionId: 'c1', eventSlug: 'match-1', size: 10 }],
            { asset: 'tok-a', conditionId: 'c1', eventSlug: 'match-1' }
        );
        expect(held).toBeUndefined();
    });
});

describe('findSameAssetPosition', () => {
    it('finds open lot on asset', () => {
        expect(
            findSameAssetPosition(
                [{ asset: 'a', size: 1, avgPrice: 0.5 }],
                'a'
            )?.avgPrice
        ).toBe(0.5);
    });
});
