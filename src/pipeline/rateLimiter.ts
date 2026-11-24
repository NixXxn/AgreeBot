import { setTimeout as sleep } from 'timers/promises';

/**
 * Sliding-window + header-aware limiter for Gravia REST (default 100/min).
 * Always leave a small remaining buffer and honor Retry-After / RateLimit-*.
 */
export class GraviaRateLimiter {
    private readonly timestamps: number[] = [];
    private cooldownUntil = 0;

    constructor(
        private readonly maxPerMinute: number,
        private readonly minRemaining: number
    ) {}

    /** Wait until a request is allowed under the local budget. */
    async acquire(): Promise<void> {
        for (;;) {
            const now = Date.now();
            if (now < this.cooldownUntil) {
                await sleep(this.cooldownUntil - now);
                continue;
            }

            const windowStart = now - 60_000;
            while (this.timestamps.length > 0 && this.timestamps[0]! < windowStart) {
                this.timestamps.shift();
            }

            const budget = Math.max(1, this.maxPerMinute - this.minRemaining);
            if (this.timestamps.length < budget) {
                this.timestamps.push(Date.now());
                return;
            }

            const waitMs = Math.max(50, this.timestamps[0]! + 60_000 - now + 25);
            await sleep(waitMs);
        }
    }

    /** Apply server rate-limit headers after a response. */
    observeHeaders(headers: Headers): void {
        const remaining = headers.get('ratelimit-remaining') ?? headers.get('RateLimit-Remaining');
        const reset = headers.get('ratelimit-reset') ?? headers.get('RateLimit-Reset');
        if (remaining !== null) {
            const rem = parseInt(remaining, 10);
            if (Number.isFinite(rem) && rem <= this.minRemaining && reset) {
                const resetSec = parseInt(reset, 10);
                if (Number.isFinite(resetSec) && resetSec > 0) {
                    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + resetSec * 1000);
                }
            }
        }
    }

    /** Back off after HTTP 429. */
    observeRetryAfter(headers: Headers, fallbackMs = 5000): void {
        const raw = headers.get('retry-after') ?? headers.get('Retry-After');
        let ms = fallbackMs;
        if (raw) {
            if (/^\d+(\.\d+)?$/.test(raw)) {
                ms = Math.max(fallbackMs, Number(raw) * 1000);
            } else {
                const abs = Date.parse(raw);
                if (Number.isFinite(abs)) ms = Math.max(fallbackMs, abs - Date.now());
            }
        }
        this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
    }
}
