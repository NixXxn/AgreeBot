import mongoose from 'mongoose';
import { PIPELINE } from './config';
import { syncGraviaWalletFilter } from './graviaClient';
import { evaluateTrader } from './evaluateTrader';
import {
    CandidateTrader,
    CuratedTraderList,
    CURATED_LIST_ID,
    PipelineStatus,
    PIPELINE_STATUS_ID,
} from './models';

const RUNTIME_SETTINGS_ID = 'overrides';

export type EvalCycleStats = {
    evaluated: number;
    passed: number;
    failed: number;
    curated: number;
    applied: boolean;
    applyMessage?: string;
    errors: number;
};

function needsRefresh(evaluatedAt: Date | undefined, now: number): boolean {
    if (!evaluatedAt) return true;
    return now - evaluatedAt.getTime() >= PIPELINE.EVAL_CACHE_MS;
}

/**
 * Pick wallets to evaluate this cycle: stale curated + hottest recent discovery hits.
 */
export async function selectEvaluationQueue(): Promise<string[]> {
    const now = Date.now();
    const curated = (await CuratedTraderList.findById(CURATED_LIST_ID)
        .lean()
        .exec()) as { addresses?: string[] } | null;
    const curatedAddresses = (curated?.addresses || []).map((a: string) => a.toLowerCase());

    const recent = (await CandidateTrader.find({})
        .sort({ lastSeenAt: -1 })
        .limit(PIPELINE.MAX_EVAL_PER_CYCLE * 2)
        .lean()
        .exec()) as unknown as Array<{
        address: string;
        lastEvaluation?: { evaluatedAt?: Date };
    }>;

    const queue: string[] = [];
    const seen = new Set<string>();

    const maybeAdd = (address: string, evaluatedAt?: Date, force = false) => {
        const a = address.toLowerCase();
        if (seen.has(a)) return;
        if (!force && !needsRefresh(evaluatedAt, now)) return;
        seen.add(a);
        queue.push(a);
    };

    for (const addr of curatedAddresses) {
        const doc = recent.find((r) => r.address === addr);
        maybeAdd(addr, doc?.lastEvaluation?.evaluatedAt);
    }

    for (const doc of recent) {
        if (queue.length >= PIPELINE.MAX_EVAL_PER_CYCLE) break;
        maybeAdd(doc.address, doc.lastEvaluation?.evaluatedAt);
    }

    // Keep curated wallets on the radar even when discovery is quiet
    if (queue.length < Math.min(10, curatedAddresses.length)) {
        for (const addr of curatedAddresses) {
            if (queue.length >= PIPELINE.MAX_EVAL_PER_CYCLE) break;
            maybeAdd(addr, undefined, true);
        }
    }

    return queue.slice(0, PIPELINE.MAX_EVAL_PER_CYCLE);
}

export async function runEvaluationCycle(): Promise<EvalCycleStats> {
    const stats: EvalCycleStats = {
        evaluated: 0,
        passed: 0,
        failed: 0,
        curated: 0,
        applied: false,
        errors: 0,
    };

    const queue = await selectEvaluationQueue();
    console.log(`[pipeline] evaluating ${queue.length} wallets`);

    for (const address of queue) {
        try {
            const snapshot = await evaluateTrader(address);
            stats.evaluated += 1;
            if (snapshot.pass) stats.passed += 1;
            else stats.failed += 1;

            await CandidateTrader.findOneAndUpdate(
                { address },
                {
                    $set: {
                        address,
                        lastEvaluation: snapshot,
                        updatedAt: new Date(),
                    },
                    $setOnInsert: {
                        firstSeenAt: new Date(),
                        lastSeenAt: new Date(),
                        discoveryTradeCount: 0,
                    },
                },
                { upsert: true }
            );
        } catch (error) {
            stats.errors += 1;
            const status = (error as { status?: number }).status;
            console.warn(
                `[pipeline] eval failed ${address.slice(0, 10)}…:`,
                error instanceof Error ? error.message : error
            );
            // Hard stop cycle on auth failure
            if (status === 401) throw error;
        }
    }

    const ranked = (await CandidateTrader.find({ 'lastEvaluation.pass': true })
        .sort({ 'lastEvaluation.score': -1 })
        .limit(PIPELINE.LIST_SIZE)
        .lean()
        .exec()) as unknown as Array<{
        address: string;
        lastEvaluation?: {
            pnl30d?: number;
            roi?: number;
            winRate?: number | null;
            volume30d?: number;
            tradesPerDay?: number;
            activeDays?: number;
            score?: number;
        };
    }>;

    const traders = ranked.map((doc, i) => ({
        address: doc.address,
        rank: i + 1,
        pnl30d: doc.lastEvaluation?.pnl30d ?? 0,
        roi: doc.lastEvaluation?.roi ?? 0,
        winRate: doc.lastEvaluation?.winRate ?? null,
        volume30d: doc.lastEvaluation?.volume30d ?? 0,
        tradesPerDay: doc.lastEvaluation?.tradesPerDay ?? 0,
        activeDays: doc.lastEvaluation?.activeDays ?? 0,
        score: doc.lastEvaluation?.score ?? 0,
    }));

    const addresses = traders.map((t) => t.address);
    stats.curated = addresses.length;

    await CuratedTraderList.findByIdAndUpdate(
        CURATED_LIST_ID,
        {
            $set: {
                addresses,
                traders,
                updatedAt: new Date(),
            },
        },
        { upsert: true }
    );

    // Drop stale failing candidates from "active curated" by rewriting list only.
    // Optionally prune ancient discovery noise.
    const pruneBefore = new Date(Date.now() - 14 * 86_400_000);
    await CandidateTrader.deleteMany({
        lastSeenAt: { $lt: pruneBefore },
        'lastEvaluation.pass': { $ne: true },
    });

    if (PIPELINE.AUTO_APPLY && addresses.length > 0) {
        const apply = await applyCuratedToBot(addresses);
        stats.applied = apply.ok;
        stats.applyMessage = apply.message;
    }

    await PipelineStatus.findByIdAndUpdate(
        PIPELINE_STATUS_ID,
        {
            $set: {
                updatedAt: new Date(),
                curatedCount: addresses.length,
                lastEvalAt: new Date(),
                lastEvalStats: {
                    evaluated: stats.evaluated,
                    passed: stats.passed,
                    failed: stats.failed,
                    curated: stats.curated,
                    errors: stats.errors,
                    applied: stats.applied ? 1 : 0,
                },
            },
        },
        { upsert: true }
    );

    console.log(
        `[pipeline] curated top ${addresses.length} | eval ${stats.evaluated} pass ${stats.passed} fail ${stats.failed} err ${stats.errors}`
    );
    return stats;
}

async function applyCuratedToBot(addresses: string[]): Promise<{ ok: boolean; message: string }> {
    const csv = addresses.join(',');
    const db = mongoose.connection.db;
    if (!db) return { ok: false, message: 'Mongo not connected' };

    // runtime_settings._id is the string "overrides" (not ObjectId)
    await db.collection('runtime_settings').updateOne(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { _id: RUNTIME_SETTINGS_ID } as any,
        {
            $set: {
                'values.USER_ADDRESSES': csv,
                updatedAt: new Date(),
            },
        },
        { upsert: true }
    );

    const gravia = await syncGraviaWalletFilter(addresses);
    let reloadMsg = 'reload skipped';
    if (PIPELINE.BOT_RELOAD_URL) {
        try {
            const res = await fetch(PIPELINE.BOT_RELOAD_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(15_000),
            });
            reloadMsg = res.ok ? 'bot reloaded' : `bot reload HTTP ${res.status}`;
        } catch (error) {
            reloadMsg =
                error instanceof Error
                    ? `bot reload failed: ${error.message}`
                    : 'bot reload failed';
        }
    }

    const message = `applied ${addresses.length} traders | ${gravia.message} | ${reloadMsg}`;
    await CuratedTraderList.findByIdAndUpdate(CURATED_LIST_ID, {
        $set: { lastApplyAt: new Date(), lastApplyMessage: message },
    });
    console.log(`[pipeline] ${message}`);
    return { ok: gravia.ok || !PIPELINE.GRAVIA_FEED_ENABLED, message };
}
