import mongoose from 'mongoose';
import { mongoUri } from './env.js';

export async function connectDatabase(): Promise<void> {
  mongoose.connection.on('error', (error) => {
    console.error('MongoDB connection error:', error);
  });

  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}
