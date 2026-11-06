import * as fs from 'fs';
import * as path from 'path';
import { ENV } from '../config/env';
import { BotSignal, BotSignalInterface } from '../models/botSignal';
import Logger from '../utils/logger';

export type RecordBotSignalInput = Omit<BotSignalInterface, 'createdAt' | 'paper'> & {
    paper?: boolean;
    createdAt?: number;
};

const LEDGER_DIR = path.join(process.cwd(), 'trader_reports');
const LEDGER_PATH = path.join(LEDGER_DIR, 'paper_ledger.jsonl');

/**
 * Append-only file backup so paper history survives Mongo wipes / redeploys
 * when the trader_reports directory is preserved (or until the next image rebuild).
 */
const appendLedgerFile = (doc: BotSignalInterface & { _id?: unknown }): void => {
    try {
        if (!fs.existsSync(LEDGER_DIR)) {
            fs.mkdirSync(LEDGER_DIR, { recursive: true });
        }
        const line = JSON.stringify({
            _id: doc._id ? String(doc._id) : undefined,
            conditionId: doc.conditionId,
            asset: doc.asset,
            side: doc.side,
            title: doc.title,
            slug: doc.slug,
            eventSlug: doc.eventSlug,
            outcome: doc.outcome,
            entryPrice: doc.entryPrice,
            sizeUsd: doc.sizeUsd,
            agreementCount: doc.agreementCount,
            agreeingTraders: doc.agreeingTraders,
            entered: doc.entered,
            paper: doc.paper,
            reason: doc.reason,
            minAgreement: doc.minAgreement,
            createdAt: doc.createdAt,
        });
        fs.appendFileSync(LEDGER_PATH, line + '\n', 'utf-8');
    } catch (error) {
        Logger.warning(
            `Failed to append paper ledger file: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};

/**
 * Persist a bot decision (entered or skipped) for the dashboard Trades / My Trades sections.
 * Always appends — never deletes older signals.
 */
export const recordBotSignal = async (input: RecordBotSignalInput): Promise<void> => {
    const payload = {
        ...input,
        paper: input.paper ?? ENV.PAPER_MODE,
        createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
    };

    try {
        const created = await BotSignal.create(payload);
        appendLedgerFile({
            ...payload,
            _id: created._id,
        });
    } catch (error) {
        Logger.warning(
            `Failed to record bot signal in Mongo: ${error instanceof Error ? error.message : String(error)}`
        );
        // Still try file backup so history is not lost
        appendLedgerFile(payload);
    }
};
