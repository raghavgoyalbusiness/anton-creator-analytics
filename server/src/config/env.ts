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

  /** Bump when CONSENT.md changes materially; creators are re-asked. */
  CONSENT_SCOPE_VERSION: z.string().default('2026-08-v1'),

  /* ------------------------------------------------------ security limits */

  /** Magic links are short-lived and single-use: assume every one is forwarded. */
  MAGIC_LINK_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  /** The session a token exchanges for. Cookie-backed, httpOnly. */
  CREATOR_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Operator sessions are shorter: this account reads every creator's data. */
  OPERATOR_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  /** Re-authentication window before a bulk export or bulk deletion. */
  OPERATOR_REAUTH_WINDOW_MINUTES: z.coerce.number().int().min(1).max(120).default(10),

  RATE_LIMIT_TOKEN_EXCHANGE_PER_IP_HOUR: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_TOKEN_EXCHANGE_PER_CREATOR_HOUR: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_UPLOADS_PER_CREATOR_HOUR: z.coerce.number().int().min(1).default(20),
  RATE_LIMIT_UPLOADS_GLOBAL_DAY: z.coerce.number().int().min(1).default(2_000),

  /* -------------------------------------------------- extraction spending */

  /** Hard stop, not a warning. Reached means extraction refuses to run. */
  EXTRACTION_DAILY_SPEND_CEILING_MINOR: z.coerce.number().int().min(0).default(5_000),
  EXTRACTION_PER_CREATOR_DAILY_CAP: z.coerce.number().int().min(1).default(25),
  EXTRACTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  EXTRACTION_ALERT_EMAIL: z.string().optional(),

  /* ------------------------------------------------------------ retention */

  /** Purge horizon after a creator's last campaign ends. */
  RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(24),
  /** Consent records outlive the data they cover; see CONSENT.md. */
  CONSENT_RETENTION_YEARS: z.coerce.number().int().min(1).max(10).default(6),

  /* -------------------------------------------------------- trust signals */

  /** Submissions later than this are recorded as lower trust, not rejected. */
  SUBMISSION_WINDOW_HOURS: z.coerce.number().int().min(1).default(72),
  /** Fraction of posts flagged for live screen-share audit. */
  SPOT_AUDIT_RATE: z.coerce.number().min(0).max(1).default(0.1),
  /** Engagement rate deviating more than this multiple of the creator median. */
  HISTORICAL_DEVIATION_MULTIPLE: z.coerce.number().min(1).default(3),
  /** Best-effort public cross-check of the submitted post URL. */
  PUBLIC_CROSSCHECK_ENABLED: z.enum(['true', 'false']).default('false'),
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
    if (!cached.EXTRACTION_ALERT_EMAIL) {
      missing.push('EXTRACTION_ALERT_EMAIL (spend-ceiling alerts would have nowhere to go)');
    }
    if (missing.length > 0) {
      throw new Error(`Refusing to start in production without:\n  ${missing.join('\n  ')}`);
    }
  }
  return cached;
}

