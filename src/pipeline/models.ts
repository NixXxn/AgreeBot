import mongoose, { Schema, Document } from 'mongoose';

export type EvaluationSnapshot = {
    evaluatedAt: Date;
    pass: boolean;
    reasons: string[];
    pnl30d: number;
    roi: number;
    winRate: number | null;
    volume30d: number;
    tradesPerDay: number;
    activeDays: number;
    tradeCount7d: number;
    betsBothSides: boolean;
    dualSidedMarkets: number;
    categorySlug?: string;
    score: number;
};

export interface CandidateTraderDocument extends Document {
    address: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
    discoveryTradeCount: number;
    lastEvaluation?: EvaluationSnapshot;
    updatedAt: Date;
}

const evaluationSchema = new Schema(
    {
        evaluatedAt: { type: Date, required: true },
        pass: { type: Boolean, required: true },
        reasons: { type: [String], default: [] },
        pnl30d: { type: Number, required: true },
        roi: { type: Number, required: true },
        winRate: { type: Number, default: null },
        volume30d: { type: Number, required: true },
        tradesPerDay: { type: Number, required: true },
        activeDays: { type: Number, required: true },
        tradeCount7d: { type: Number, required: true },
        betsBothSides: { type: Boolean, required: true },
        dualSidedMarkets: { type: Number, required: true },
        categorySlug: { type: String },
        score: { type: Number, required: true },
    },
    { _id: false }
);

const candidateSchema = new Schema(
    {
        address: { type: String, required: true, unique: true, lowercase: true },
        firstSeenAt: { type: Date, required: true },
        lastSeenAt: { type: Date, required: true },
        discoveryTradeCount: { type: Number, default: 0 },
        lastEvaluation: { type: evaluationSchema, required: false },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'pipeline_candidates' }
);

candidateSchema.index({ lastSeenAt: -1 });
candidateSchema.index({ 'lastEvaluation.pass': 1, 'lastEvaluation.score': -1 });

export const CandidateTrader =
    mongoose.models.CandidateTrader ||
    mongoose.model<CandidateTraderDocument>('CandidateTrader', candidateSchema);

export interface CuratedTraderListDocument extends Document {
    _id: string;
    addresses: string[];
    /** Wallets last written into USER_ADDRESSES by the pipeline (for merge/replace). */
    appliedAddresses: string[];
    traders: Array<{
        address: string;
        rank: number;
        pnl30d: number;
        roi: number;
        winRate: number | null;
        volume30d: number;
        tradesPerDay: number;
        activeDays: number;
        score: number;
    }>;
    updatedAt: Date;
    lastApplyAt?: Date;
    lastApplyMessage?: string;
}

const curatedSchema = new Schema(
    {
        _id: { type: String, required: true },
        addresses: { type: [String], default: [] },
        appliedAddresses: { type: [String], default: [] },
        traders: {
            type: [
                {
                    address: String,
                    rank: Number,
                    pnl30d: Number,
                    roi: Number,
                    winRate: Number,
                    volume30d: Number,
                    tradesPerDay: Number,
                    activeDays: Number,
                    score: Number,
                },
            ],
            default: [],
        },
        updatedAt: { type: Date, default: Date.now },
        lastApplyAt: { type: Date },
        lastApplyMessage: { type: String },
    },
    { collection: 'pipeline_curated_traders' }
);

export const CuratedTraderList =
    mongoose.models.CuratedTraderList ||
    mongoose.model<CuratedTraderListDocument>('CuratedTraderList', curatedSchema);

export const CURATED_LIST_ID = 'crypto_5m_top';

export interface PipelineStatusDocument extends Document {
    _id: string;
    startedAt: Date;
    updatedAt: Date;
    discoveryConnected: boolean;
    marketsTracked: number;
    candidates: number;
    curatedCount: number;
    lastEvalAt?: Date;
    lastEvalStats?: Record<string, number | string>;
    lastError?: string;
}

const statusSchema = new Schema(
    {
        _id: { type: String, required: true },
        startedAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
        discoveryConnected: { type: Boolean, default: false },
        marketsTracked: { type: Number, default: 0 },
        candidates: { type: Number, default: 0 },
        curatedCount: { type: Number, default: 0 },
        lastEvalAt: { type: Date },
        lastEvalStats: { type: Schema.Types.Mixed },
        lastError: { type: String },
    },
    { collection: 'pipeline_status' }
);

export const PipelineStatus =
    mongoose.models.PipelineStatus ||
    mongoose.model<PipelineStatusDocument>('PipelineStatus', statusSchema);

export const PIPELINE_STATUS_ID = 'main';
