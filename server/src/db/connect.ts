import mongoose from 'mongoose';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../config/env.js';

let memoryServer: { stop: () => Promise<boolean> } | null = null;
let uriFilePath: string | null = null;

/**
 * Connects to MongoDB.
 *
 * With MONGODB_URI set, uses it directly.
 *
 * Without it, development boots an in-process MongoDB via mongodb-memory-server
 * against a persisted dbPath, so a dev machine needs no Mongo installation but
 * keeps its data between runs. The first such boot downloads a MongoDB binary
 * (~66 MB) and needs network access.
 *
 * Only one process can hold a dbPath's lock, so the process that boots the
 * server publishes its URI to a sidecar file. A second process — a seed script
 * run while `npm run dev` is up, say — finds that file and joins the running
 * instance instead of failing on DBPathInUse.
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
    uriFilePath = path.join(dbPath, 'server-uri');

    const existing = await joinRunningInstance(uriFilePath);
    if (existing) {
      console.log('[db] joined the MongoDB already running for this dbPath');
      return mongoose.connection.host;
    }

    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create({
      instance: { dbPath, storageEngine: 'wiredTiger', dbName: 'anton' },
    });
    memoryServer = server;
    uri = server.getUri('anton');
    await writeFile(uriFilePath, uri, 'utf8');
    console.log(`[db] in-process MongoDB at ${dbPath}`);
  }

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10_000,
    autoIndex: env.NODE_ENV !== 'production',
  });
  return mongoose.connection.host;
}

/**
 * Tries the URI a sibling process published. A stale file (the owner died
 * without cleaning up) fails fast and we fall through to booting our own.
 */
async function joinRunningInstance(filePath: string): Promise<boolean> {
  let published: string;
  try {
    published = (await readFile(filePath, 'utf8')).trim();
  } catch {
    return false;
  }
  if (!published) return false;

  try {
    await mongoose.connect(published, { serverSelectionTimeoutMS: 1_500 });
    return true;
  } catch {
    await mongoose.disconnect().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    return false;
  }
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  if (memoryServer) {
    // Only the process that started the server tears it down and clears the
    // sidecar; a joining process must leave both alone.
    await memoryServer.stop();
    memoryServer = null;
    if (uriFilePath) await rm(uriFilePath, { force: true }).catch(() => undefined);
  }
  uriFilePath = null;
}
