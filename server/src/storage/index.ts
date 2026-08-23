import path from 'node:path';
import { loadEnv } from '../config/env.js';
import { LocalDiskAdapter } from './local.js';
import { S3Adapter } from './s3.js';
import type { StorageAdapter } from './types.js';

let cached: StorageAdapter | null = null;

export function getStorage(): StorageAdapter {
  if (cached) return cached;
  const env = loadEnv();

  if (env.STORAGE_DRIVER === 's3') {
    const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const)
      .filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(`STORAGE_DRIVER=s3 requires: ${missing.join(', ')}`);
    }
    cached = new S3Adapter(
      env.S3_BUCKET ?? '',
      env.S3_REGION ?? '',
      {
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      },
      env.S3_ENDPOINT,
    );
    return cached;
  }

  cached = new LocalDiskAdapter(
    path.resolve(process.cwd(), env.STORAGE_LOCAL_PATH),
    env.TOKEN_SECRET,
    `http://localhost:${env.PORT}`,
  );
  return cached;
}

/** Test-only. */
export function resetStorageCache(): void {
  cached = null;
}

export { LocalDiskAdapter } from './local.js';
export { S3Adapter } from './s3.js';
export * from './types.js';
