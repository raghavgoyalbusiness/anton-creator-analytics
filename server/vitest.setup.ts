import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * One MongoDB server, one database per worker.
 *
 * globalSetup boots a single mongod so that starting and stopping servers
 * cannot race on the dbPath lock. This file does the other half: it points
 * each worker at its OWN database inside that server.
 *
 * Both halves are needed, and skipping either one produces failures that look
 * like application bugs:
 *
 *   Without the shared server, every worker booted and stopped its own mongod
 *   on the same data directory, and shutdown raced startup. The symptom was a
 *   transport-level failure on a random request in a random file.
 *
 *   Without the per-worker database, the workers share `anton` and trample
 *   each other's fixtures — duplicate-key errors on a creator handle two test
 *   files both happen to use, sessions that belong to another file's operator,
 *   counts that include another file's rows.
 *
 * Setting MONGODB_URI is enough: connectDb() uses it directly and boots
 * nothing, so no production code knows or cares that this is a test.
 */
// Top level, not an exported hook: a setup file is executed, not called.
{
  const dbPath = path.resolve(process.cwd(), process.env.MONGO_DEV_DB_PATH ?? '.mongo-test-data');
  const base = readFileSync(path.join(dbPath, 'server-uri'), 'utf8').trim();

  // Vitest numbers its workers from 1; the fallback keeps a direct `vitest`
  // invocation without a pool working rather than silently sharing a database.
  const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0';

  const url = new URL(base);
  url.pathname = `/anton_test_${worker}`;
  process.env.MONGODB_URI = url.toString();
}
