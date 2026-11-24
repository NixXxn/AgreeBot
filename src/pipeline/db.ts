import mongoose from 'mongoose';
import { PIPELINE } from './config';

export async function connectPipelineDb(): Promise<void> {
    mongoose.set('strictQuery', true);
    await mongoose.connect(PIPELINE.MONGO_URI);
    console.log('[pipeline] MongoDB connected');
}

export async function closePipelineDb(): Promise<void> {
    await mongoose.connection.close();
    console.log('[pipeline] MongoDB closed');
}
