import { ENV } from '../config/env';
import { BotSignal, BotSignalInterface } from '../models/botSignal';
import Logger from '../utils/logger';

export type RecordBotSignalInput = Omit<BotSignalInterface, 'createdAt' | 'paper'> & {
    paper?: boolean;
    createdAt?: number;
};

/**
 * Persist a bot decision (entered or skipped) for the dashboard Trades section.
 */
export const recordBotSignal = async (input: RecordBotSignalInput): Promise<void> => {
    try {
        await BotSignal.create({
            ...input,
            paper: input.paper ?? ENV.PAPER_MODE,
            createdAt: input.createdAt ?? Math.floor(Date.now() / 1000),
        });
    } catch (error) {
        Logger.warning(
            `Failed to record bot signal: ${error instanceof Error ? error.message : String(error)}`
        );
    }
};
