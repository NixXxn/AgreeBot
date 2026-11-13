import mongoose, { Schema, Document } from 'mongoose';

export interface AutoClaimStateDocument extends Document {
    _id: string;
    /** Current ladder baseline (USD). Claim fires when CLOB cash ≥ 2× baseline. */
    baseline: number;
    /** Last successful payout amount (USD). */
    lastPayoutUsd?: number;
    /** Recipient of last payout. */
    lastRecipient?: string;
    /** Relayer / tx id of last payout. */
    lastTxId?: string;
    /** When baseline was last updated. */
    updatedAt: Date;
}

const autoClaimStateSchema = new Schema(
    {
        _id: { type: String, required: true },
        baseline: { type: Number, required: true, default: 0 },
        lastPayoutUsd: { type: Number, required: false },
        lastRecipient: { type: String, required: false },
        lastTxId: { type: String, required: false },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'auto_claim_state' }
);

export const AutoClaimState =
    mongoose.models.AutoClaimState ||
    mongoose.model<AutoClaimStateDocument>('AutoClaimState', autoClaimStateSchema);

export const AUTO_CLAIM_STATE_ID = 'default';
