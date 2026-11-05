import mongoose, { Schema, Document } from 'mongoose';

export interface BotSignalInterface {
    conditionId: string;
    asset: string;
    side: 'BUY' | 'SELL';
    title?: string;
    slug?: string;
    eventSlug?: string;
    outcome?: string;
    entryPrice: number;
    sizeUsd: number;
    agreementCount: number;
    agreeingTraders: string[];
    entered: boolean;
    paper: boolean;
    reason?: string; // e.g. 'consensus', 'consensus_expired', 'copy'
    minAgreement?: number;
    createdAt: number; // unix seconds
}

export interface BotSignalDocument extends BotSignalInterface, Document {}

const botSignalSchema = new Schema(
    {
        conditionId: { type: String, required: true, index: true },
        asset: { type: String, required: true, index: true },
        side: { type: String, required: true },
        title: { type: String, required: false },
        slug: { type: String, required: false },
        eventSlug: { type: String, required: false },
        outcome: { type: String, required: false },
        entryPrice: { type: Number, required: true },
        sizeUsd: { type: Number, required: true, default: 0 },
        agreementCount: { type: Number, required: true, default: 1 },
        agreeingTraders: { type: [String], required: true, default: [] },
        entered: { type: Boolean, required: true, default: false },
        paper: { type: Boolean, required: true, default: false },
        reason: { type: String, required: false },
        minAgreement: { type: Number, required: false },
        createdAt: { type: Number, required: true, index: true },
    },
    { collection: 'bot_signals' }
);

botSignalSchema.index({ conditionId: 1, asset: 1, side: 1, createdAt: -1 });

export const BotSignal =
    mongoose.models.BotSignal ||
    mongoose.model<BotSignalDocument>('BotSignal', botSignalSchema);
