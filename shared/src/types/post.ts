import type { MetricSource, Platform, PostFormat } from './common.js';
import type { MetricKey, PostMetrics } from './metrics.js';

export type ExtractionStatus =
  | 'pending'
  | 'auto_accepted'
  | 'needs_review'
  | 'verified'
  | 'rejected';

export const EXTRACTION_STATUSES = [
  'pending',
  'auto_accepted',
  'needs_review',
  'verified',
  'rejected',
] as const satisfies readonly ExtractionStatus[];

/** Statuses whose numbers may appear in a brand-facing report. */
export const BRAND_REPORTABLE_STATUSES = ['auto_accepted', 'verified'] as const;

export type PlausibilityRuleId =
  | 'reach_exceeds_follower_multiple'
  | 'engagement_rate_implausible'
  | 'impressions_below_reach'
  | 'engagements_exceed_impressions'
  | 'metric_negative_or_non_integer'
  | 'posted_at_in_future'
  | 'posted_at_before_campaign_start';

export interface PlausibilityViolation {
  readonly rule: PlausibilityRuleId;
  /** Operator-facing sentence explaining what is wrong and why it matters. */
  readonly message: string;
  readonly fields: readonly MetricKey[];
  /**
   * `fail` blocks auto-acceptance outright. `warn` is surfaced in the queue but
   * does not on its own hold a post back. Every rule the brief names is `fail`.
   */
  readonly severity: 'fail' | 'warn';
  readonly observed: Readonly<Record<string, number | string | null>>;
}

export interface PlausibilityResult {
  readonly passed: boolean;
  readonly violations: readonly PlausibilityViolation[];
  /** Rules skipped because an input was null. Shown so absence is never silent. */
  readonly skipped: readonly { rule: PlausibilityRuleId; reason: string }[];
}

/**
 * The immutable audit record for one vision extraction attempt.
 * `rawResponse` is the model's output verbatim as a string, stored whether or
 * not it parsed. If it did not parse, that string is the only evidence of why.
 */
export interface ExtractionRecord {
  readonly sourceImageKey: string;
  readonly sourceImageSha256: string;
  readonly extractedAt: Date;
  readonly model: string;
  readonly promptVersion: string;
  readonly rawResponse: string;
  readonly parseOk: boolean;
  readonly parseError: string | null;
  readonly detectedPlatform: Platform | 'unknown' | null;
  readonly detectedScreenType: string | null;
  readonly modelNotes: string | null;
  readonly fieldConfidence: Readonly<Partial<Record<MetricKey, number>>>;
  readonly plausibility: PlausibilityResult;
  readonly status: ExtractionStatus;
  /** Human-readable reasons the post was routed to needs_review. */
  readonly routingReasons: readonly string[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * DEVIATION FROM BRIEF, deliberate.
 * The brief specifies `manualOverrides: Record<string, {from,to,by,at}>`. A map
 * keyed by field name loses history the second time a field is corrected — the
 * first correction is overwritten. Given the whole proposition is traceability,
 * this is an append-only array instead. `overridesByField()` below reproduces
 * the Record shape for any UI that wants "current override per field".
 */
export interface MetricOverride {
  readonly field: MetricKey;
  readonly from: number | null;
  readonly to: number | null;
  readonly by: string;
  readonly at: Date;
  readonly reason: string | null;
}

export interface Post {
  readonly id: string;
  readonly creatorId: string;
  readonly campaignId: string;
  readonly platform: Platform;
  readonly format: PostFormat;
  readonly publicUrl: string | null;
  readonly postedAt: Date;
  readonly caption: string | null;
  /** Operator-assigned creative angle, e.g. "before/after", "unboxing". */
  readonly creativeAngleTags: readonly string[];
  /** The hook line, transcribed by the operator. Drives "top hooks" in reports. */
  readonly hookText: string | null;

  /** The canonical numbers. Post-override, post-verification. */
  readonly metrics: PostMetrics;

  /** Phase 2 seam: how these numbers arrived. */
  readonly metricSource: MetricSource;
  /** Present iff metricSource === 'screenshot'. Null for OAuth/manual rows. */
  readonly extraction: ExtractionRecord | null;

  readonly verifiedByOperatorId: string | null;
  readonly verifiedAt: Date | null;
  readonly rejectedReason: string | null;
  readonly manualOverrides: readonly MetricOverride[];

  readonly submittedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The brief's Record shape, derived: latest override per field. */
export function overridesByField(
  overrides: readonly MetricOverride[],
): Readonly<Partial<Record<MetricKey, MetricOverride>>> {
  const out: Partial<Record<MetricKey, MetricOverride>> = {};
  for (const o of overrides) {
    const existing = out[o.field];
    if (!existing || existing.at.getTime() <= o.at.getTime()) out[o.field] = o;
  }
  return out;
}

/** True when this post's numbers are allowed in front of a brand. */
export function isBrandReportable(post: Pick<Post, 'extraction' | 'metricSource'>): boolean {
  if (post.metricSource !== 'screenshot') return true;
  const status = post.extraction?.status;
  return status === 'verified' || status === 'auto_accepted';
}
