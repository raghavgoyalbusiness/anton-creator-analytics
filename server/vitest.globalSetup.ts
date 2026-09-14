import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * One MongoDB for the whole test run.
 *
 * This exists because of a real, intermittent failure. Vitest runs each test
 * file in its own worker process, so every file was calling connectDb() —
 * booting its own mongodb-memory-server against the same persisted dbPath —
 * and disconnectDb() in afterAll, stopping it again. `fileParallelism: false`
 * serialises the FILES but not the processes' startup and shutdown: file N's
 * mongod was still releasing the dbPath lock while file N+1 was taking it.
 *
 * The symptom was a transport-level failure on a random request in a random
 * file — a socket hang-up, or an HTTP status no route in this codebase can
 * produce — roughly once every eight full runs, and never reproducible when
 * that file was run on its own. Four separate test files were blamed for it
 * before the pattern was clear.
 *
 * Booting once here and publishing the URI to the sidecar file connectDb
 * already looks for means every worker JOINS one instance and none of them
 * stops it. The race has nowhere left to happen.
 */

let server: { stop: () => Promise<boolean> } | null = null;
let uriFile: string | null = null;

export async function setup(): Promise<void> {
  const dbPath = path.resolve(process.cwd(), process.env.MONGO_DEV_DB_PATH ?? '.mongo-test-data');

  /**
   * A previous run killed mid-flight leaves a lock file behind, and mongod
   * refuses to start on it. Tests are disposable, so the directory is cleared
   * rather than repaired.
   */
  await rm(dbPath, { recursive: true, force: true });
  await mkdir(dbPath, { recursive: true });

  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const instance = await MongoMemoryServer.create({
    instance: { dbPath, storageEngine: 'wiredTiger', dbName: 'anton' },
  });
  server = instance;

  uriFile = path.join(dbPath, 'server-uri');
  await writeFile(uriFile, instance.getUri('anton'), 'utf8');
}

export async function teardown(): Promise<void> {
  if (uriFile) await rm(uriFile, { force: true }).catch(() => undefined);
  if (server) await server.stop();
  server = null;
  uriFile = null;
}
