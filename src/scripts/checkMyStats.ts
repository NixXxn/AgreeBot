import { ENV } from '../config/env';
import getMyBalance from '../utils/getMyBalance';
import { fetchUserActivity, fetchUserPositions } from '../utils/polymarketData';

const PROXY_WALLET = ENV.PROXY_WALLET;

const checkMyStats = async () => {
    console.log('🔍 Checking Polymarket wallet stats\n');
    console.log(`Wallet (POLY_FUNDER / PROXY_WALLET): ${PROXY_WALLET}\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        console.log('💰 TRADING BALANCE (CLOB collateral, not wallet ERC-20)');
        const balance = await getMyBalance(PROXY_WALLET);
        console.log(`   Available: $${balance.toFixed(2)}\n`);

        console.log('📊 OPEN POSITIONS');
        const positions = await fetchUserPositions(PROXY_WALLET, { limit: 500 });

        if (positions.length > 0) {
            console.log(`   Positions: ${positions.length}\n`);

            let totalValue = 0;
            let totalInitialValue = 0;
            let totalUnrealizedPnl = 0;
            let totalRealizedPnl = 0;

            for (const pos of positions) {
                totalValue += pos.currentValue || 0;
                totalInitialValue += pos.initialValue || 0;
                totalUnrealizedPnl += pos.cashPnl || 0;
                totalRealizedPnl += pos.realizedPnl || 0;
            }

            console.log(`   Current value: $${totalValue.toFixed(2)}`);
            console.log(`   Entry cost: $${totalInitialValue.toFixed(2)}`);
            console.log(
                `   Unrealized P/L: $${totalUnrealizedPnl.toFixed(2)}${
                    totalInitialValue > 0
                        ? ` (${((totalUnrealizedPnl / totalInitialValue) * 100).toFixed(2)}%)`
                        : ''
                }`
            );
            console.log(`   Realized P/L: $${totalRealizedPnl.toFixed(2)}\n`);

            console.log('   Top 5 by P/L %:\n');
            const topPositions = [...positions]
                .sort((a, b) => (b.percentPnl || 0) - (a.percentPnl || 0))
                .slice(0, 5);

            topPositions.forEach((pos, idx) => {
                const pnlSign = (pos.percentPnl || 0) >= 0 ? '+' : '';
                console.log(`   ${idx + 1}. ${pos.title || 'Unknown'} (${pos.outcome || 'N/A'})`);
                console.log(
                    `      size ${pos.size.toFixed(2)} @ $${pos.avgPrice.toFixed(3)} · P/L $${(pos.cashPnl || 0).toFixed(2)} (${pnlSign}${(pos.percentPnl || 0).toFixed(1)}%)`
                );
                if (pos.slug) console.log(`      https://polymarket.com/event/${pos.slug}`);
                console.log('');
            });
        } else {
            console.log('   No open positions\n');
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('📜 RECENT TRADES (last 20)\n');
        const activities = await fetchUserActivity(PROXY_WALLET, {
            type: 'TRADE',
            limit: 50,
        });

        if (activities.length > 0) {
            const buyTrades = activities.filter((a) => a.side === 'BUY');
            const sellTrades = activities.filter((a) => a.side === 'SELL');
            const totalBuyVolume = buyTrades.reduce((sum, t) => sum + t.usdcSize, 0);
            const totalSellVolume = sellTrades.reduce((sum, t) => sum + t.usdcSize, 0);

            console.log(
                `   Buys: ${buyTrades.length} ($${totalBuyVolume.toFixed(2)}) · Sells: ${sellTrades.length} ($${totalSellVolume.toFixed(2)})\n`
            );

            activities.slice(0, 20).forEach((trade, idx) => {
                const date = new Date(trade.timestamp * 1000);
                console.log(
                    `   ${idx + 1}. ${trade.side} ${date.toISOString()} · $${trade.usdcSize.toFixed(2)} @ $${trade.price.toFixed(3)}`
                );
                console.log(`      ${trade.title || 'Unknown'} (${trade.outcome || 'N/A'})`);
                console.log('');
            });
        } else {
            console.log('   No trade history found\n');
        }

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log(`Profile: https://polymarket.com/profile/${PROXY_WALLET}\n`);
        console.log('✅ Done\n');
    } catch (error) {
        console.error('❌ Failed to fetch stats:', error);
        process.exitCode = 1;
    }
};

checkMyStats();
