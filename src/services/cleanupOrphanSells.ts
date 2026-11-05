import { BotSignal } from '../models/botSignal';
import Logger from '../utils/logger';

/**
 * Mark paper SELLs as not-entered when there was never an entered BUY on that asset.
 * Fixes historical rows that were logged before the "no sell without buy" rule.
 */
export const cleanupOrphanPaperSells = async (): Promise<number> => {
    try {
        const sells = await BotSignal.find({
            side: 'SELL',
            entered: true,
            paper: true,
        })
            .lean()
            .exec();

        if (sells.length === 0) return 0;

        const buys = await BotSignal.find({
            side: 'BUY',
            entered: true,
        })
            .select({ asset: 1, createdAt: 1 })
            .lean()
            .exec();

        const orphanIds = sells
            .filter((s) => {
                const asset = String(s.asset);
                const when = Number(s.createdAt || 0);
                // Valid only if we entered a BUY on the same asset earlier
                return !buys.some(
                    (b) => String(b.asset) === asset && Number(b.createdAt || 0) <= when
                );
            })
            .map((s) => s._id);

        if (orphanIds.length === 0) return 0;

        const result = await BotSignal.updateMany(
            { _id: { $in: orphanIds } },
            { $set: { entered: false, reason: 'no_position', sizeUsd: 0 } }
        );

        const n = result.modifiedCount || 0;
        if (n > 0) {
            Logger.info(`Cleaned ${n} orphan paper SELL signal(s) (no prior BUY)`);
        }
        return n;
    } catch (error) {
        Logger.warning(
            `Orphan SELL cleanup failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return 0;
    }
};
