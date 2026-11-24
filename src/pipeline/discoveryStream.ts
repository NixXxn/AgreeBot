import { PIPELINE } from './config';
import { getCurrentCryptoMarket, type CurrentMarket } from './graviaClient';
import { CandidateTrader } from './models';

type TradeFrame = {
    type?: string;
    status?: string;
    user_address?: string;
    condition_id?: string;
    token_id?: string;
};

export type DiscoveryStats = {
    connected: boolean;
    marketsTracked: number;
    tradesSeen: number;
    candidatesTouched: number;
    lastMarketRefreshAt?: Date;
    lastError?: string;
};

/**
 * Live Gravia transaction stream filtered to current crypto 5m condition IDs.
 * Discovery only — never blocks the copy-trading bot process.
 */
export class DiscoveryStream {
    private ws: WebSocket | null = null;
    private stopped = false;
    private reconnectAttempt = 0;
    private marketRefreshTimer: NodeJS.Timeout | null = null;
    private markets = new Map<string, CurrentMarket>();
    private pendingCandidateWrites = new Map<
        string,
        { lastSeenAt: Date; delta: number }
    >();
    private flushTimer: NodeJS.Timeout | null = null;

    readonly stats: DiscoveryStats = {
        connected: false,
        marketsTracked: 0,
        tradesSeen: 0,
        candidatesTouched: 0,
    };

    async start(): Promise<void> {
        this.stopped = false;
        await this.refreshMarkets();
        this.connect();
        this.marketRefreshTimer = setInterval(() => {
            this.refreshMarkets().catch((err) => {
                this.stats.lastError =
                    err instanceof Error ? err.message : String(err);
            });
        }, PIPELINE.MARKET_REFRESH_MS);
        this.flushTimer = setInterval(() => {
            this.flushCandidates().catch(() => undefined);
        }, 5_000);
    }

    stop(): void {
        this.stopped = true;
        if (this.marketRefreshTimer) clearInterval(this.marketRefreshTimer);
        if (this.flushTimer) clearInterval(this.flushTimer);
        this.ws?.close();
        this.ws = null;
        this.stats.connected = false;
        void this.flushCandidates();
    }

    getConditionIds(): string[] {
        return [...this.markets.keys()];
    }

    private connect(): void {
        if (this.stopped) return;

        const url = new URL(`${PIPELINE.GRAVIA_BASE.replace('https://', 'wss://')}/api/v1/streams/transactions`);
        url.searchParams.set('streams', 'trades');
        url.searchParams.set('mempool', 'false');
        url.searchParams.set('api_key', PIPELINE.GRAVIA_API);

        const ws = new WebSocket(url.toString());
        this.ws = ws;

        ws.addEventListener('open', () => {
            this.stats.connected = true;
            this.reconnectAttempt = 0;
            this.applyMarketFilter();
            console.log('[pipeline] discovery WS connected');
        });

        ws.addEventListener('message', (event) => {
            try {
                const raw = typeof event.data === 'string' ? event.data : String(event.data);
                this.onMessage(JSON.parse(raw));
            } catch {
                /* ignore malformed frames */
            }
        });

        ws.addEventListener('close', () => {
            this.stats.connected = false;
            this.ws = null;
            if (this.stopped) return;
            const delay = Math.min(60_000, 1000 * 2 ** this.reconnectAttempt);
            this.reconnectAttempt += 1;
            console.warn(`[pipeline] discovery WS closed — reconnect in ${delay}ms`);
            setTimeout(() => this.connect(), delay);
        });

        ws.addEventListener('error', () => {
            this.stats.lastError = 'websocket_error';
        });
    }

    private onMessage(msg: TradeFrame & { action?: string; type?: string }): void {
        if (msg.type === 'welcome' || msg.type === 'heartbeat' || msg.type === 'pong') return;
        if (msg.type === 'filter.updated' || msg.type === 'filter.rejected') return;
        if (msg.type !== 'trade') return;
        if (msg.status && msg.status !== 'confirmed') return;

        const wallet = (msg.user_address || '').toLowerCase();
        const conditionId = (msg.condition_id || '').toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(wallet)) return;
        if (!conditionId || !this.markets.has(conditionId)) return;

        this.stats.tradesSeen += 1;
        const prev = this.pendingCandidateWrites.get(wallet);
        this.pendingCandidateWrites.set(wallet, {
            lastSeenAt: new Date(),
            delta: (prev?.delta || 0) + 1,
        });
    }

    private async refreshMarkets(): Promise<void> {
        const next = new Map<string, CurrentMarket>();
        for (const crypto of PIPELINE.CRYPTOS) {
            try {
                const market = await getCurrentCryptoMarket(crypto, PIPELINE.INTERVAL);
                if (market?.condition_id) {
                    next.set(market.condition_id.toLowerCase(), market);
                }
            } catch (error) {
                this.stats.lastError =
                    error instanceof Error ? error.message : String(error);
            }
        }
        this.markets = next;
        this.stats.marketsTracked = next.size;
        this.stats.lastMarketRefreshAt = new Date();
        this.applyMarketFilter();
        console.log(
            `[pipeline] tracking ${next.size} crypto ${PIPELINE.INTERVAL} markets: ${[...next.values()]
                .map((m) => m.crypto)
                .join(',')}`
        );
    }

    private applyMarketFilter(): void {
        // WebSocket.OPEN === 1 (Node / WHATWG)
        if (!this.ws || this.ws.readyState !== 1) return;
        const markets = [...this.markets.keys()];
        // Clear then set so rotated markets drop out of the filter.
        this.ws.send(JSON.stringify({ action: 'filter.clear', target: 'markets' }));
        if (markets.length > 0) {
            this.ws.send(JSON.stringify({ action: 'filter.add', markets }));
        }
    }

    private async flushCandidates(): Promise<void> {
        if (this.pendingCandidateWrites.size === 0) return;
        const batch = [...this.pendingCandidateWrites.entries()];
        this.pendingCandidateWrites.clear();

        const ops = batch.map(([address, info]) => ({
            updateOne: {
                filter: { address },
                update: {
                    $set: { lastSeenAt: info.lastSeenAt, updatedAt: new Date() },
                    $setOnInsert: { firstSeenAt: info.lastSeenAt, address },
                    $inc: { discoveryTradeCount: info.delta },
                },
                upsert: true,
            },
        }));

        await CandidateTrader.bulkWrite(ops, { ordered: false });
        this.stats.candidatesTouched += batch.length;
    }
}
