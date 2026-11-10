import * as fs from 'fs';
import * as path from 'path';
import { BotSignal } from '../models/botSignal';
import { RuntimeSettings, RUNTIME_SETTINGS_ID } from '../models/runtimeSettings';
import Logger from '../utils/logger';

const LEDGER_PATH = path.join(process.cwd(), 'trader_reports', 'paper_ledger.jsonl');
const MIGRATION_KEY = 'reclassifiedBogusLiveSignalsV1';

/**
 * Earlier builds recorded live "entered" rows whenever postOrder returned void,
 * even with no CLOB fill. Those rows show under Live with fake P/L while Paper
 * looks empty. One-shot: move all non-paper signals into the paper ledger.
 */
export const reclassifyBogusLiveSignals = async (): Promise<number> => {
    try {
        const doc = await RuntimeSettings.findById(RUNTIME_SETTINGS_ID).lean().exec();
        const values =
            doc?.values && typeof doc.values === 'object'
                ? (doc.values as Record<string, string>)
                : {};
        if (values[MIGRATION_KEY] === 'true') {
            return 0;
        }

        const result = await BotSignal.updateMany(
            { $or: [{ paper: false }, { paper: { $exists: false } }] },
            { $set: { paper: true } }
        );
        const modified = result.modifiedCount ?? 0;

        // Rewrite JSONL backup so dashboard file merge stays consistent
        try {
            if (fs.existsSync(LEDGER_PATH)) {
                const lines = fs.readFileSync(LEDGER_PATH, 'utf-8').split('\n');
                const out = lines.map((line) => {
                    if (!line.trim()) return line;
                    try {
                        const row = JSON.parse(line) as Record<string, unknown>;
                        row.paper = true;
                        return JSON.stringify(row);
                    } catch {
                        return line;
                    }
                });
                fs.writeFileSync(LEDGER_PATH, out.join('\n'), 'utf-8');
            }
        } catch (error) {
            Logger.warning(
                `Could not rewrite paper_ledger.jsonl during reclassify: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }

        await RuntimeSettings.findByIdAndUpdate(
            RUNTIME_SETTINGS_ID,
            {
                $set: {
                    [`values.${MIGRATION_KEY}`]: 'true',
                    updatedAt: new Date(),
                },
                $setOnInsert: { values: { [MIGRATION_KEY]: 'true' } },
            },
            { upsert: true }
        );

        if (modified > 0) {
            Logger.success(
                `Reclassified ${modified} mis-tagged live signal(s) → paper (no confirmed CLOB fills)`
            );
        } else {
            Logger.info('Live→paper signal reclassify: nothing to move');
        }

        return modified;
    } catch (error) {
        Logger.warning(
            `Live→paper reclassify failed: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        return 0;
    }
};
