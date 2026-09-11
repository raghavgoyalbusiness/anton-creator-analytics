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
    // Indexes are built by ensureIndexes() below, which fails loudly. Mongoose's
    // own autoIndex reports a failed build on an event nobody is listening to.
    serverSelectionTimeoutMS: 10_000,
    autoIndex: false,
  });

  if (env.NODE_ENV !== 'production') await ensureIndexes();

  return mongoose.connection.host;
}

/**
 * Builds every model's indexes, and throws if any of them cannot be built.
 *
 * This exists because of a real bug. An index declared inline with
 * `index: true` and again through `schema.index()` produces two requests with
 * the same auto-generated name; Mongo rejects the second, and with autoIndex on
 * that rejection surfaces only as an `index` event on the model. The result was
 * a UNIQUE constraint — the one stopping an order being credited to two
 * creators — quietly not existing, while every test that did not specifically
 * probe the database still passed.
 *
 * syncIndexes rather than createIndexes: it also drops an index whose
 * definition has changed, so a stale one left over from an earlier schema
 * cannot go on shadowing the current definition. That makes it unsafe against
 * a production database holding indexes this code does not know about, which is
 * why production builds them through a deliberate migration instead.
 */
export async function ensureIndexes(): Promise<void> {
  const failures: string[] = [];

  for (const name of mongoose.modelNames()) {
    try {
      await mongoose.model(name).syncIndexes();
    } catch (err: unknown) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Index build failed, so a constraint this code relies on is not in force:\n  ${failures.join('\n  ')}`,
    );
  }
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
