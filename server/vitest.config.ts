import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // One in-process MongoDB, shared across files. Parallel forks would each
    // boot their own and race on the same persisted dbPath.
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
