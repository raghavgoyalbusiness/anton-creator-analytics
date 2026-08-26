import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { ApiError } from './errors.js';

/**
 * Database-backed fixed-window rate limiting.
 *
 * In the database rather than in process memory on purpose: the counters must
 * survive a restart and hold across more than one API instance. A creator who
 * can reset their upload quota by waiting for a deploy is not rate limited.
 *
 * Fixed windows, not sliding: a burst straddling a boundary can briefly reach
 * 2x the limit. Accepted deliberately — these limits exist to stop runaway cost
 * and automated abuse, not to shape traffic to the request, and a sliding
 * window costs a great deal more machinery for that difference.
 */
const rateCounterSchema = new Schema(
  {
    /** `${bucket}:${subject}:${windowStartMs}` */
    key: { type: String, required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
    windowStartsAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'rate_counters', timestamps: false },
);
rateCounterSchema.index({ key: 1 }, { unique: true });
rateCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

type RateCounterDoc = InferSchemaType<typeof rateCounterSchema>;
const RateCounterModel: Model<RateCounterDoc> = model<RateCounterDoc>(
  'RateCounter',
  rateCounterSchema,
);

export interface RateLimitRule {
  /** What is being limited, e.g. 'token_exchange_ip'. */
  readonly bucket: string;
  /** Who or what it is scoped to: an IP hash, a creator id, or 'global'. */
  readonly subject: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
}

/**
 * Consumes one unit against a rule. Atomic: the increment and the read are a
 * single findOneAndUpdate, so two concurrent requests cannot both see the last
 * remaining slot.
 */
export async function consumeRateLimit(rule: RateLimitRule): Promise<RateLimitVerdict> {
  const now = Date.now();
  const windowStartMs = Math.floor(now / rule.windowMs) * rule.windowMs;
  const resetAt = new Date(windowStartMs + rule.windowMs);
  const key = `${rule.bucket}:${rule.subject}:${windowStartMs}`;

  const doc = await RateCounterModel.findOneAndUpdate(
    { key },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        windowStartsAt: new Date(windowStartMs),
        // Kept a window beyond reset so Mongo's TTL reaper, which runs about
        // once a minute, never removes a counter that is still authoritative.
        expiresAt: new Date(windowStartMs + rule.windowMs * 2),
      },
    },
    { upsert: true, new: true },
  ).lean();

  const count = doc?.count ?? 1;
  return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count), resetAt };
}

/** Consumes and throws 429 when exhausted. */
export async function enforceRateLimit(
  rule: RateLimitRule,
  message: string,
): Promise<RateLimitVerdict> {
  const verdict = await consumeRateLimit(rule);
  if (!verdict.allowed) {
    throw new ApiError(429, 'rate_limited', message, {
      retryAfterSeconds: Math.ceil((verdict.resetAt.getTime() - Date.now()) / 1000),
    });
  }
  return verdict;
}


export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Test-only. */
export async function clearRateLimits(): Promise<void> {
  await RateCounterModel.deleteMany({});
}
