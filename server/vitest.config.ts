import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * One MongoDB for the whole run, booted in globalSetup.
     *
     * Each test file is its own worker process, so without this every file
     * booted and stopped its own mongod on the same dbPath — and file N's
     * shutdown raced file N+1's startup. See vitest.globalSetup.ts; the
     * failures that caused looked like bugs in four unrelated test files.
     */
    globalSetup: ['./vitest.globalSetup.ts'],
    // And this points each worker at its own database inside that server, so
    // two test files cannot trample each other's fixtures.
    setupFiles: ['./vitest.setup.ts'],
    // Serial: every file hashes passwords with Argon2id in beforeEach, and
    // running them concurrently turns CPU contention into timeouts.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      MONGO_DEV_DB_PATH: '.mongo-test-data',
      STORAGE_LOCAL_PATH: '.storage-test',
    },
  },
});
