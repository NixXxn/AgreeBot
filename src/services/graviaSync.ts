import { ENV } from '../config/env';
import Logger from '../utils/logger';

const GRAVIA_BASE = 'https://data.gravia.trade';
const GRAVIA_MAX_WALLET_FILTER = 500;

const webhookUrl = (): string => {
    const path = ENV.GRAVIA_WEBHOOK_PATH.startsWith('/')
        ? ENV.GRAVIA_WEBHOOK_PATH
        : `/${ENV.GRAVIA_WEBHOOK_PATH}`;
    return `${ENV.GRAVIA_PUBLIC_BASE_URL}${path}`;
};

/**
 * Activate the Gravia subscription and set wallet_addresses to the current
 * dashboard trader list (capped at 500). Safe to call on boot and after saves.
 */
export const syncGraviaSubscription = async (
    wallets: string[] = ENV.USER_ADDRESSES
): Promise<{ ok: boolean; message: string }> => {
    if (!ENV.GRAVIA_FEED_ENABLED) {
        return { ok: true, message: 'Gravia feed disabled' };
    }
    if (!ENV.GRAVIA_API || !ENV.GRAVIA_SUBSCRIPTION_ID) {
        Logger.warning(
            'Gravia feed enabled but GRAVIA_API / GRAVIA_SUBSCRIPTION_ID missing — skip sync'
        );
        return { ok: false, message: 'Missing GRAVIA_API or GRAVIA_SUBSCRIPTION_ID' };
    }

    const wallet_addresses = wallets
        .map((w) => w.toLowerCase())
        .filter((w) => /^0x[a-f0-9]{40}$/.test(w))
        .slice(0, GRAVIA_MAX_WALLET_FILTER);

    const payload: Record<string, unknown> = {
        url: webhookUrl(),
        status: 'active',
        description: 'AgreeBot trader feed',
        filters: { wallet_addresses },
    };
    if (ENV.GRAVIA_SIGNING_SECRET) {
        payload.secret = ENV.GRAVIA_SIGNING_SECRET;
    }

    try {
        const res = await fetch(
            `${GRAVIA_BASE}/v1/webhooks/${ENV.GRAVIA_SUBSCRIPTION_ID}`,
            {
                method: 'PUT',
                headers: {
                    Authorization: ENV.GRAVIA_API,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            }
        );
        const body = (await res.json().catch(() => null)) as {
            success?: boolean;
            message?: string;
        } | null;

        if (!res.ok || body?.success === false) {
            const msg = body?.message || `HTTP ${res.status}`;
            Logger.warning(`Gravia subscription sync failed: ${msg}`);
            return { ok: false, message: msg };
        }

        const msg = `Gravia webhook active → ${webhookUrl()} (${wallet_addresses.length} wallets)`;
        Logger.success(msg);
        return { ok: true, message: msg };
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        Logger.warning(`Gravia subscription sync error: ${msg}`);
        return { ok: false, message: msg };
    }
};
