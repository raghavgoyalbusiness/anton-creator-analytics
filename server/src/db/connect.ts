import mongoose from 'mongoose';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../config/env.js';

let memoryServer: { stop: () => Promise<boolean> } | null = null;

/**
 * Connects to MongoDB.
 *
 * With MONGODB_URI set, uses it directly. Without it, boots an in-process
 * MongoDB via mongodb-memory-server against a persisted dbPath, so a dev
 * machine needs no Mongo installation but still keeps its data between runs.
 * The first such boot downloads a MongoDB binary and needs network access.
 */
export async function connectDb(): Promise<string> {
  const env = loadEnv();
  if (mongoose.connection.readyState === 1) return mongoose.connection.host;

  let uri = env.MONGODB_URI;

  if (!uri) {
    if (env.NODE_ENV === 'production') {
      throw new Error('MONGODB_URI is required in production');
    }
    const dbPath = path.resolve(process.cwd(), env.MONGO_DEV_DB_PATH);
    await mkdir(dbPath, { recursive: true });
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger', dbName: 'anton' },
    });
    memoryServer = server;
    uri = server.getUri('anton');
    console.log(`[db] in-process MongoDB at ${dbPath}`);
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: env.NODE_ENV !== 'production',
  });
  return mongoose.connection.host;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    await memoryServer.stop();
    memoryServer = null;
  }
}
