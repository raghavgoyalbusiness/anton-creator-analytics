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
    /** Empty until the extraction runs; enforced non-empty past 'pending' below. */
    model: { type: String, default: '', maxlength: 80 },
    /** Which prompt revision produced this. Extractions are not comparable across revisions. */
    promptVersion: { type: String, default: '', maxlength: 32 },
    rawResponse: { type: String, default: '' },
    parseOk: { type: Boolean, default: false },
    parseError: { type: String, default: null },
    detectedPlatform: { type: String, enum: [...PLATFORMS, 'unknown', null], default: null },
    detectedScreenType: { type: String, default: null },
    modelNotes: { type: String, default: null, maxlength: 200 },
    fieldConfidence: { type: metricConfidenceSchema, required: true, default: () => ({}) },
    /** Fails closed: an un-run plausibility pass is not a passed one. */
    plausibility: {
      type: plausibilityResultSchema,
      required: true,
      default: () => ({ passed: false, violations: [], skipped: [] }),
    },
    status: { type: String, required: true, enum: EXTRACTION_STATUSES, default: 'pending' },
    routingReasons: { type: [String], default: [] },
    /**
     * The model reported instruction-like text inside the image. Never
     * auto-accepts, always alerts, and the creator's submission history is
     * worth reviewing when this fires.
     */
    instructionTextDetected: { type: Boolean, default: false },
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

    /**
     * Trust signals. None of these decide anything on their own; they are the
     * evidence an operator weighs, and they exist because a screenshot is
     * forgeable and the product must not pretend otherwise.
     */
    trust: {
      type: new Schema(
        {
          /** Hours between postedAt and submission. Late is lower trust, not rejected. */
          submissionLagHours: { type: Number, default: null, min: 0 },
          withinSubmissionWindow: { type: Boolean, default: null },
          /**
           * EXIF presence before stripping. Absence is NORMAL for a screenshot
           * and is explicitly not a red flag; presence of camera EXIF means a
           * photo of a screen, which is worth an operator's eye.
           */
          exifPresent: { type: Boolean, default: null },
          exifCaptureTimestamp: { type: Date, default: null },
          /** Random 10% flagged for live screen-share verification. */
          flaggedForSpotAudit: { type: Boolean, default: false },
          spotAuditOutcome: {
            type: String,
            enum: ['passed', 'failed', 'creator_declined', 'not_contactable', null],
            default: null,
          },
          spotAuditAt: { type: Date, default: null },
          /**
           * Best-effort fetch of the creator's own submitted post URL.
           * `status` is usually 'unavailable': both platforms serve login walls
           * to server-side fetches, so this can inform but can never be relied on.
           */
          publicCrossCheck: {
            type: new Schema(
              {
                status: {
                  type: String,
                  enum: ['matched', 'diverged', 'unavailable', 'blocked', 'not_attempted'],
                  required: true,
                },
                checkedAt: { type: Date, default: null },
                publicLikes: { type: Number, default: null, min: 0 },
                publicComments: { type: Number, default: null, min: 0 },
                divergenceRatio: { type: Number, default: null },
                note: { type: String, default: null, maxlength: 300 },
              },
              { _id: false },
            ),
            default: null,
          },
          /** Engagement rate vs this creator's rolling median. */
          historicalDeviation: {
            type: new Schema(
              {
                creatorMedianEngagementRate: { type: Number, default: null },
                thisEngagementRate: { type: Number, default: null },
                deviationMultiple: { type: Number, default: null },
                exceededThreshold: { type: Boolean, default: false },
                sampleSize: { type: Number, default: 0, min: 0 },
              },
              { _id: false },
            ),
            default: null,
          },
        },
        { _id: false },
      ),
      default: () => ({}),
    },

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
postSchema.index({ 'trust.flaggedForSpotAudit': 1, 'trust.spotAuditOutcome': 1 });
postSchema.index({ 'extraction.instructionTextDetected': 1 });
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
  if (this.metricSource === 'screenshot' && this.extraction == null) {
    next(new Error('a screenshot-sourced post must carry an extraction record'));
    return;
  }
  if (this.metricSource !== 'screenshot' && this.extraction != null) {
    next(new Error(`metricSource '${this.metricSource}' must not carry a screenshot extraction record`));
    return;
  }

  const extraction = this.extraction;
  if (extraction != null && extraction.status !== 'pending') {
    // Past 'pending' the audit record must be complete. A post cannot reach a
    // decided state without the exact model output that produced it: that
    // string plus the source image is the entire evidentiary chain, and a
    // decided-but-empty record would be a number with nothing behind it.
    const missing: string[] = [];
    if (!extraction.rawResponse) missing.push('rawResponse');
    if (!extraction.model) missing.push('model');
    if (!extraction.promptVersion) missing.push('promptVersion');
    if (missing.length > 0) {
      next(
        new Error(
          `extraction.status '${extraction.status}' requires a complete audit record; missing: ${missing.join(', ')}`,
        ),
      );
      return;
    }
  }

  // A verified or rejected post must name the human who decided it.
  if (extraction != null && (extraction.status === 'verified' || extraction.status === 'rejected')) {
    if (this.verifiedByOperatorId == null) {
      next(new Error(`extraction.status '${extraction.status}' requires verifiedByOperatorId`));
      return;
    }
  }

  next();
});

export type PostDoc = InferSchemaType<typeof postSchema>;
export const PostModel: Model<PostDoc> = model<PostDoc>('Post', postSchema);
