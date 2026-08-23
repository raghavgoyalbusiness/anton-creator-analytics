import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { connectDb, disconnectDb } from './db/connect.js';

const env = loadEnv();
await connectDb();

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT}`);
  console.log(`[api] storage driver: ${env.STORAGE_DRIVER}`);
  if (!env.ANTHROPIC_API_KEY) {
    console.warn('[api] ANTHROPIC_API_KEY is not set: extraction will not run.');
  }
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`\n[api] ${signal}, shutting down`);
  server.close();
  await disconnectDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
