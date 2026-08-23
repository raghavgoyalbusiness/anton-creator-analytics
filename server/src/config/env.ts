import { z } from 'zod';

/**
 * Environment is validated once, at boot, and fails loudly. A server that
 * starts with a missing ANTHROPIC_API_KEY and only discovers it on the first
 * extraction has already accepted a creator's upload it cannot process.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5310),
  WEB_ORIGIN: z.string().default('http://localhost:5210'),

  /**
   * Leave unset in development to boot an in-process MongoDB via
   * mongodb-memory-server, persisted at MONGO_DEV_DB_PATH. Set it to an Atlas
   * URI for anything real.
   */
  MONGODB_URI: z.string().optional(),
  MONGO_DEV_DB_PATH: z.string().default('.mongo-data'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('.storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  /** Signs magic-link and share tokens, and local presigned URLs. */
  TOKEN_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-please!!'),
  /** Salt for the consent IP hash. Rotating it breaks nothing; it is one-way. */
  IP_HASH_SALT: z.string().min(16).default('dev-only-ip-salt-change-me'),

  CONSENT_SCOPE_VERSION: z.string().default('2026-08-v1'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${detail}`);
  }
  cached = parsed.data;

  if (cached.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (!cached.MONGODB_URI) missing.push('MONGODB_URI');
    if (!cached.ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
    if (cached.STORAGE_DRIVER !== 's3') missing.push("STORAGE_DRIVER must be 's3'");
    if (cached.TOKEN_SECRET.startsWith('dev-only')) missing.push('TOKEN_SECRET (still the dev default)');
    if (cached.IP_HASH_SALT.startsWith('dev-only')) missing.push('IP_HASH_SALT (still the dev default)');
    if (missing.length > 0) {
      throw new Error(`Refusing to start in production without:\n  ${missing.join('\n  ')}`);
    }
  }
  return cached;
}

/** Test-only. */
export function resetEnvCache(): void {
  cached = null;
}
