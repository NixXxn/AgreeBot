import mongoose, { Schema, Document } from 'mongoose';

/**
 * In-flight consensus groups mirrored to Mongo so the dashboard can show them
 * while waiting for more traders (the in-memory buffer alone is invisible to Next).
 */
export interface ConsensusPendingDocument extends Document {
    _id: string;
    conditionId: string;
    asset: string;
    side: string;
    outcome?: string;
    title?: string;
    slug?: string;
    eventSlug?: string;
    traders: number;
    required: number;
    agreeingTraders: string[];
    firstTradeAt: number;
    updatedAt: Date;
}

const consensusPendingSchema = new Schema(
    {
        _id: { type: String, required: true },
        conditionId: { type: String, required: true },
        asset: { type: String, required: true },
        side: { type: String, required: true },
        outcome: { type: String, required: false },
        title: { type: String, required: false },
        slug: { type: String, required: false },
        eventSlug: { type: String, required: false },
        traders: { type: Number, required: true },
        required: { type: Number, required: true },
        agreeingTraders: { type: [String], required: true, default: [] },
        firstTradeAt: { type: Number, required: true },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'consensus_pending' }
);

export const ConsensusPending =
    mongoose.models.ConsensusPending ||
    mongoose.model<ConsensusPendingDocument>('ConsensusPending', consensusPendingSchema);
