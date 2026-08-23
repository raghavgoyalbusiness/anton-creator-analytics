import { z } from 'zod';
import { METRIC_KEYS, type MetricKey } from '../types/metrics.js';

export const metricKeySchema = z.enum(METRIC_KEYS);

/**
 * A single metric value. Non-negative whole number, or null for "not known".
 * The integer constraint is enforced here as well as in the plausibility rules
 * so a malformed number cannot reach the database even if a caller skips the
 * plausibility pass.
 */
export const metricValueSchema = z
  .number()
  .int('platform counters are whole numbers')
  .nonnegative()
  .max(50_000_000_000, 'implausibly large for a micro-creator post')
  .nullable();

/** The full, exhaustive metric object. Every key required, each nullable. */
export const postMetricsSchema = z.object(
  Object.fromEntries(METRIC_KEYS.map((k) => [k, metricValueSchema])) as {
    [K in MetricKey]: typeof metricValueSchema;
  },
);

/** The partial form the vision model is allowed to return. */
export const partialMetricsSchema = z.object(
  Object.fromEntries(METRIC_KEYS.map((k) => [k, metricValueSchema.optional()])) as {
    [K in MetricKey]: z.ZodOptional<typeof metricValueSchema>;
  },
);

/**
 * Partial by design: the model scores only the fields it actually read.
 * z.record() with an enum key is exhaustive in zod 4 and would reject every
 * real response, so partialRecord is load-bearing here, not stylistic.
 */
export const fieldConfidenceSchema = z.partialRecord(metricKeySchema, z.number().min(0).max(1));
