import mongoose, { Schema, Document } from 'mongoose';

/** One successful auto-claim payout (persisted for Settings history). */
export interface AutoClaimHistoryEntry {
    at: Date;
    amountUsd: number;
    recipient: string;
    txHash?: string;
    txId?: string;
    /** e.g. "100→200" */
    stage?: string;
    baselineBefore: number;
    baselineAfter: number;
    cashBefore: number;
}

export interface AutoClaimStateDocument extends Document {
    _id: string;
    /** Current ladder baseline (USD). Claim fires when CLOB cash ≥ 2× baseline. */
    baseline: number;
    /** Last time we ran a cash check (throttles to once per AUTO_CLAIM_INTERVAL). */
    lastCheckAt?: Date;
    /** Last successful payout amount (USD). */
    lastPayoutUsd?: number;
    /** Recipient of last payout. */
    lastRecipient?: string;
    /** Relayer / tx id of last payout. */
    lastTxId?: string;
    /** Chronological payout log (newest first after $position:0 pushes). */
    history: AutoClaimHistoryEntry[];
    /** When baseline was last updated. */
    updatedAt: Date;
}

const historyEntrySchema = new Schema(
    {
        at: { type: Date, required: true },
        amountUsd: { type: Number, required: true },
        recipient: { type: String, required: true },
        txHash: { type: String, required: false },
        txId: { type: String, required: false },
        stage: { type: String, required: false },
        baselineBefore: { type: Number, required: true },
        baselineAfter: { type: Number, required: true },
        cashBefore: { type: Number, required: true },
    },
    { _id: false }
);

const autoClaimStateSchema = new Schema(
    {
        _id: { type: String, required: true },
        baseline: { type: Number, required: true, default: 0 },
        lastCheckAt: { type: Date, required: false },
        lastPayoutUsd: { type: Number, required: false },
        lastRecipient: { type: String, required: false },
        lastTxId: { type: String, required: false },
        history: { type: [historyEntrySchema], default: [] },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'auto_claim_state' }
);

export const AutoClaimState =
    mongoose.models.AutoClaimState ||
    mongoose.model<AutoClaimStateDocument>('AutoClaimState', autoClaimStateSchema);

export const AUTO_CLAIM_STATE_ID = 'default';
/** Keep the most recent N payouts in the Settings log. */
export const AUTO_CLAIM_HISTORY_LIMIT = 50;
