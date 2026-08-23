import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import {
  EXTRACTION_STATUSES,
  METRIC_KEYS,
  METRIC_SOURCES,
  PLATFORMS,
  POST_FORMATS,
} from '@anton/shared';
import { metricConfidenceSchema, postMetricsSchema } from './shared-subdocs.js';

const plausibilityViolationSchema = new Schema(
  {
    rule: { type: String, required: true },
    message: { type: String, required: true },
    fields: { type: [String], default: [] },
    severity: { type: String, required: true, enum: ['fail', 'warn'] },
    observed: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const plausibilityResultSchema = new Schema(
  {
    passed: { type: Boolean, required: true },
    violations: { type: [plausibilityViolationSchema], default: [] },
    /** Rules we could not evaluate. Recorded so absence is never silent. */
    skipped: {
      type: [new Schema({ rule: String, reason: String }, { _id: false })],
      default: [],
    },
  },
  { _id: false },
);

/**
 * The extraction audit record.
 *
 * `rawResponse` is the model's output byte-for-byte, stored whether or not it
 * parsed. When a number in a brand report is challenged, this string plus the
 * image at `sourceImageKey` is the entire evidentiary chain.
 */
const extractionRecordSchema = new Schema(
  {
    sourceImageKey: { type: String, required: true, maxlength: 512 },
    /** Content hash of the uploaded image. Detects re-uploads and tampering. */
    sourceImageSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    extractedAt: { type: Date, required: true },
    model: { type: String, required: true, maxlength: 80 },
    /** Which prompt revision produced this. Extractions are not comparable across revisions. */
    promptVersion: { type: String, required: true, maxlength: 32 },
    rawResponse: { type: String, required: true },
    parseOk: { type: Boolean, required: true },
    parseError: { type: String, default: null },
    detectedPlatform: { type: String, enum: [...PLATFORMS, 'unknown', null], default: null },
    detectedScreenType: { type: String, default: null },
    modelNotes: { type: String, default: null, maxlength: 200 },
    fieldConfidence: { type: metricConfidenceSchema, required: true, default: () => ({}) },
    plausibility: { type: plausibilityResultSchema, required: true },
    status: { type: String, required: true, enum: EXTRACTION_STATUSES, default: 'pending' },
    routingReasons: { type: [String], default: [] },
    inputTokens: { type: Number, default: null, min: 0 },
    outputTokens: { type: Number, default: null, min: 0 },
  },
  { _id: false },
);

/**
 * One correction to one metric, by one operator, at one moment.
 * Append-only array rather than the brief's keyed Record: see MetricOverride
 * in shared for why a Record loses the first of two corrections.
 */
const metricOverrideSchema = new Schema(
  {
    field: { type: String, required: true, enum: METRIC_KEYS },
    from: { type: Number, default: null },
    to: { type: Number, default: null },
    by: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
    at: { type: Date, required: true },
    reason: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const postSchema = new Schema(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    platform: { type: String, required: true, enum: PLATFORMS },
    format: { type: String, required: true, enum: POST_FORMATS },
    publicUrl: { type: String, default: null },
    postedAt: { type: Date, required: true, index: true },
    caption: { type: String, default: null, maxlength: 2200 },
    creativeAngleTags: { type: [String], default: [], index: true },
    hookText: { type: String, default: null, maxlength: 300 },

    /** The canonical numbers: post-override, post-verification. */
    metrics: { type: postMetricsSchema, required: true, default: () => ({}) },

    /** Phase 2 seam. An OAuth adapter writes the same Post with a new source. */
    metricSource: { type: String, required: true, enum: METRIC_SOURCES, default: 'screenshot' },
    /** Present iff metricSource === 'screenshot'. */
    extraction: { type: extractionRecordSchema, default: null },

    verifiedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
    verifiedAt: { type: Date, default: null },
    rejectedReason: { type: String, default: null, maxlength: 500 },
    manualOverrides: { type: [metricOverrideSchema], default: [] },

    submittedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: true, collection: 'posts' },
);

/** The verification queue: oldest pending work first, per status. */
postSchema.index({ 'extraction.status': 1, submittedAt: 1 });
postSchema.index({ campaignId: 1, 'extraction.status': 1 });
postSchema.index({ 'extraction.plausibility.passed': 1, 'extraction.status': 1 });
postSchema.index({ campaignId: 1, creatorId: 1, postedAt: -1 });
/**
 * Sparse unique on publicUrl: the same post must not be submitted twice, but
 * many posts legitimately have no public URL (stories expire), and a plain
 * unique index would let only ONE such document exist.
 */
postSchema.index(
  { publicUrl: 1 },
  { unique: true, partialFilterExpression: { publicUrl: { $type: 'string' } } },
);

postSchema.pre('validate', function validateSourceInvariant(next) {
  if (this.metricSource === 'screenshot' && this.extraction === null) {
    next(new Error('a screenshot-sourced post must carry an extraction record'));
    return;
  }
  if (this.metricSource !== 'screenshot' && this.extraction !== null) {
    next(new Error(`metricSource '${this.metricSource}' must not carry a screenshot extraction record`));
    return;
  }
  next();
});

export type PostDoc = InferSchemaType<typeof postSchema>;
export const PostModel: Model<PostDoc> = model<PostDoc>('Post', postSchema);
