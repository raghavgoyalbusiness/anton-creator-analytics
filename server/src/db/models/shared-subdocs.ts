import { Schema, type SchemaDefinition } from 'mongoose';
import {
  METRIC_KEYS,
  PLATFORMS,
  type MetricKey,
  type Money,
  type PostMetrics,
} from '@anton/shared';

/**
 * Reusable sub-schemas. `_id: false` throughout: these are value objects, not
 * entities, and giving each an ObjectId makes diffing an audit trail harder.
 */

/** Integer minor units + currency. The validator is the guard against floats. */
export const moneySchema = new Schema<Money>(
  {
    amountMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: 'money must be whole minor units (pence/cents); {VALUE} is not an integer',
      },
    },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
  },
  { _id: false },
);

/**
 * The metric block. Every key is explicitly declared and defaults to null, so
 * a missing metric is stored as a null rather than as an absent path. That
 * distinction matters: `{ $exists: false }` and `null` behave differently in
 * aggregation, and the report must be able to count "not captured" reliably.
 */
interface MetricPathDefinition {
  readonly type: NumberConstructor;
  readonly default: null;
  readonly min: number;
  readonly validate: {
    readonly validator: (v: number | null) => boolean;
    readonly message: string;
  };
}

const metricPaths = Object.fromEntries(
  METRIC_KEYS.map((key): [MetricKey, MetricPathDefinition] => [
    key,
    {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (v: number | null) => v === null || Number.isInteger(v),
        message: `${key} must be a whole number or null`,
      },
    },
  ]),
) as Record<MetricKey, MetricPathDefinition>;

export const postMetricsSchema: Schema<PostMetrics> = new Schema(
  metricPaths as unknown as SchemaDefinition<PostMetrics>,
  { _id: false },
);

export const followerSnapshotSchema = new Schema(
  {
    platform: { type: String, required: true, enum: PLATFORMS },
    count: { type: Number, required: true, min: 0 },
    capturedAt: { type: Date, required: true },
    source: { type: String, required: true, enum: ['manual', 'screenshot', 'oauth'] },
  },
  { _id: false },
);

/**
 * Per-field confidence, 0..1, null when the model did not score that field.
 *
 * A fixed sub-schema rather than a Map: the metric vocabulary is closed, so
 * this rejects confidence for a key that is not a metric, survives .lean()
 * as a plain object, and lets the review queue be driven by an indexable
 * query such as { 'extraction.fieldConfidence.reach': { $lt: 0.85 } }.
 */
interface ConfidencePathDefinition {
  readonly type: NumberConstructor;
  readonly default: null;
  readonly min: number;
  readonly max: number;
}

const confidencePaths = Object.fromEntries(
  METRIC_KEYS.map((key): [MetricKey, ConfidencePathDefinition] => [
    key,
    { type: Number, default: null, min: 0, max: 1 },
  ]),
) as Record<MetricKey, ConfidencePathDefinition>;

export const metricConfidenceSchema = new Schema(confidencePaths, { _id: false });
