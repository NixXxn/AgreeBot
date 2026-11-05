import mongoose, { Schema, Document } from 'mongoose';

/**
 * Dashboard-editable overrides that survive Coolify restarts.
 * Coolify process.env is the base; this document wins for matching keys.
 */
export interface RuntimeSettingsDocument extends Document {
    _id: string;
    values: Record<string, string>;
    updatedAt: Date;
}

const runtimeSettingsSchema = new Schema(
    {
        _id: { type: String, required: true },
        values: { type: Schema.Types.Mixed, default: {} },
        updatedAt: { type: Date, default: Date.now },
    },
    { collection: 'runtime_settings' }
);

export const RuntimeSettings =
    mongoose.models.RuntimeSettings ||
    mongoose.model<RuntimeSettingsDocument>('RuntimeSettings', runtimeSettingsSchema);

export const RUNTIME_SETTINGS_ID = 'overrides';
