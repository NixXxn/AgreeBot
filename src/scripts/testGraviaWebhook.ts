/**
 * Activate subscription (if needed) and request a Gravia test callback.
 * Usage: npx ts-node src/scripts/testGraviaWebhook.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const apiKey = (process.env.GRAVIA_API || process.env.GRAVIA_API_KEY || '').trim();
    const subId = (process.env.GRAVIA_SUBSCRIPTION_ID || '').trim();
    const base = (process.env.GRAVIA_PUBLIC_BASE_URL || 'https://btc.webwien.at').replace(
        /\/$/,
        ''
    );
    const path = process.env.GRAVIA_WEBHOOK_PATH || '/api/webhooks/gravia';
    const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    if (!apiKey || !subId) {
        console.error('Set GRAVIA_API and GRAVIA_SUBSCRIPTION_ID');
        process.exit(1);
    }

    console.log(`Webhook URL: ${url}`);
    console.log(`Subscription: ${subId}`);

    const put = await fetch(`https://data.gravia.trade/v1/webhooks/${subId}`, {
        method: 'PUT',
        headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            url,
            status: 'active',
            secret: process.env.GRAVIA_SIGNING_SECRET || undefined,
        }),
    });
    const putBody = await put.json().catch(() => null);
    console.log('PUT activate:', put.status, JSON.stringify(putBody)?.slice(0, 400));

    const test = await fetch(`https://data.gravia.trade/v1/webhooks/${subId}/test`, {
        method: 'POST',
        headers: {
            Authorization: apiKey,
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    const testBody = await test.json().catch(() => null);
    console.log('POST test:', test.status, JSON.stringify(testBody, null, 2));

    const delivery = testBody?.data;
    if (delivery?.success) {
        console.log('✓ Gravia reached your receiver successfully');
    } else {
        console.log(
            '✗ Delivery failed — deploy the webhook route, check HMAC secret, then retry'
        );
        console.log('  Expected receiver:', url);
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
