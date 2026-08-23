import { ENGAGEMENT_METRIC_KEYS, METRIC_KEYS, type MetricKey, type PostMetrics } from '../types/metrics.js';
import type { PlausibilityResult, PlausibilityRuleId, PlausibilityViolation } from '../types/post.js';
import { engagementRate } from './definitions.js';

/**
 * Thresholds, named so they can be quoted in an operator-facing message and
 * tuned in exactly one place.
 */
export const PLAUSIBILITY_THRESHOLDS = Object.freeze({
  /** reach above followers x this is treated as implausible, not merely viral. */
  reachFollowerMultiple: 50,
  /** engagement rate above this fraction is treated as implausible. */
  maxEngagementRate: 0.25,
});

/** Any field below this confidence sends the whole post to needs_review. */
export const MIN_FIELD_CONFIDENCE = 0.85;

export interface PlausibilityInput {
  readonly metrics: PostMetrics;
  readonly postedAt: Date;
  readonly campaignStartDate: Date;
  /**
   * Follower count as at postedAt, not today's. Null when we hold no snapshot,
   * in which case the follower-multiple rule is skipped rather than guessed.
   */
  readonly followerCountAtPost: number | null;
  readonly now: Date;
}

/**
 * Evaluates every rule the brief specifies. Flags, never corrects. A failure
 * means the post cannot auto-accept and lands in the operator queue with the
 * reason attached; it does not mean any number gets rewritten.
 */
export function evaluatePlausibility(input: PlausibilityInput): PlausibilityResult {
  const violations: PlausibilityViolation[] = [];
  const skipped: { rule: PlausibilityRuleId; reason: string }[] = [];
  const m = input.metrics;

  // Rule 5 first: a negative or fractional value poisons every other rule.
  const malformed: MetricKey[] = [];
  for (const key of METRIC_KEYS) {
    const value = m[key];
    if (value === null) continue;
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) malformed.push(key);
  }
  if (malformed.length > 0) {
    violations.push({
      rule: 'metric_negative_or_non_integer',
      message: `Not a whole non-negative number: ${malformed.join(', ')}. Platform panels never show negative or fractional counts, so this is a misread rather than a real value.`,
      fields: malformed,
      severity: 'fail',
      observed: Object.fromEntries(malformed.map((k) => [k, m[k]])),
    });
  }

  // Rule 1: reach vs follower count at time of posting.
  if (m.reach === null) {
    skipped.push({ rule: 'reach_exceeds_follower_multiple', reason: 'reach not captured' });
  } else if (input.followerCountAtPost === null) {
    skipped.push({
      rule: 'reach_exceeds_follower_multiple',
      reason: 'no follower snapshot at or before postedAt',
    });
  } else {
    const ceiling = input.followerCountAtPost * PLAUSIBILITY_THRESHOLDS.reachFollowerMultiple;
    if (m.reach > ceiling) {
      violations.push({
        rule: 'reach_exceeds_follower_multiple',
        message: `Reach of ${m.reach.toLocaleString()} is more than ${PLAUSIBILITY_THRESHOLDS.reachFollowerMultiple}x the ${input.followerCountAtPost.toLocaleString()} followers held when this was posted. Check the screenshot is this creator's, and that a 'K'/'M' suffix was read correctly.`,
        fields: ['reach'],
        severity: 'fail',
        observed: { reach: m.reach, followerCountAtPost: input.followerCountAtPost, ceiling },
      });
    }
  }

  // Rule 2: engagement rate ceiling.
  const er = engagementRate(m);
  if (er.value === null) {
    skipped.push({ rule: 'engagement_rate_implausible', reason: er.unavailableReason ?? 'inputs missing' });
  } else if (er.value > PLAUSIBILITY_THRESHOLDS.maxEngagementRate) {
    violations.push({
      rule: 'engagement_rate_implausible',
      message: `Engagement rate of ${(er.value * 100).toFixed(1)}% exceeds the ${(PLAUSIBILITY_THRESHOLDS.maxEngagementRate * 100).toFixed(0)}% ceiling (${er.basis}). Usually means reach was misread low, or an engagement figure was misread high.`,
      fields: [...ENGAGEMENT_METRIC_KEYS, 'reach'],
      severity: 'fail',
      observed: { engagementRate: er.value, basis: er.basis, reach: m.reach, impressions: m.impressions },
    });
  }

  // Rule 3: impressions must be >= reach (impressions count repeat views).
  if (m.impressions === null || m.reach === null) {
    skipped.push({ rule: 'impressions_below_reach', reason: 'impressions or reach not captured' });
  } else if (m.impressions < m.reach) {
    violations.push({
      rule: 'impressions_below_reach',
      message: `Impressions (${m.impressions.toLocaleString()}) are below reach (${m.reach.toLocaleString()}). Impressions count repeat views and can never be lower than the number of unique accounts reached, so one of the two was misread.`,
      fields: ['impressions', 'reach'],
      severity: 'fail',
      observed: { impressions: m.impressions, reach: m.reach },
    });
  }

  // Rule 4: engagements cannot exceed the views that produced them.
  const engagementParts = ENGAGEMENT_METRIC_KEYS.filter((k) => m[k] !== null);
  const viewDenominator = m.impressions ?? m.reach;
  const viewDenominatorLabel = m.impressions !== null ? 'impressions' : 'reach';
  if (engagementParts.length === 0 || viewDenominator === null) {
    skipped.push({
      rule: 'engagements_exceed_impressions',
      reason: 'no engagement metric captured, or neither impressions nor reach captured',
    });
  } else {
    const engagementSum = engagementParts.reduce((acc, k) => acc + (m[k] ?? 0), 0);
    if (engagementSum > viewDenominator) {
      violations.push({
        rule: 'engagements_exceed_impressions',
        message: `Engagements total ${engagementSum.toLocaleString()}, above ${viewDenominatorLabel} of ${viewDenominator.toLocaleString()}. A post cannot be engaged with more times than it was seen.`,
        fields: [...engagementParts, viewDenominatorLabel === 'impressions' ? 'impressions' : 'reach'],
        severity: 'fail',
        observed: { engagementSum, [viewDenominatorLabel]: viewDenominator },
      });
    }
  }

  // Rule 6a: postedAt in the future.
  if (input.postedAt.getTime() > input.now.getTime()) {
    violations.push({
      rule: 'posted_at_in_future',
      message: `Posted date ${input.postedAt.toISOString()} is in the future.`,
      fields: [],
      severity: 'fail',
      observed: { postedAt: input.postedAt.toISOString(), now: input.now.toISOString() },
    });
  }

  // Rule 6b: postedAt before the campaign began.
  if (input.postedAt.getTime() < input.campaignStartDate.getTime()) {
    violations.push({
      rule: 'posted_at_before_campaign_start',
      message: `Posted date ${input.postedAt.toISOString()} precedes the campaign start ${input.campaignStartDate.toISOString()}. This post cannot be attributed to the campaign as dated.`,
      fields: [],
      severity: 'fail',
      observed: {
        postedAt: input.postedAt.toISOString(),
        campaignStartDate: input.campaignStartDate.toISOString(),
      },
    });
  }

  return {
    passed: violations.every((v) => v.severity !== 'fail'),
    violations,
    skipped,
  };
}

export interface ConfidenceRoutingInput {
  readonly fieldConfidence: Readonly<Partial<Record<MetricKey, number>>>;
  readonly metrics: PostMetrics;
  readonly plausibility: PlausibilityResult;
  /**
   * What the model believed it was looking at. A profile page or an
   * unrecognised screen must never auto-accept: those are the cases where the
   * creator uploaded the wrong image, and the numbers on them are not this
   * post's numbers.
   */
  readonly screenType?: 'post_insights' | 'story_insights' | 'profile' | 'unrecognized';
}

export interface RoutingDecision {
  readonly status: 'auto_accepted' | 'needs_review';
  readonly reasons: readonly string[];
  readonly lowConfidenceFields: readonly MetricKey[];
}

/**
 * Confidence routing. A post auto-accepts only when every non-null metric
 * carries confidence at or above MIN_FIELD_CONFIDENCE and no plausibility rule
 * failed. Anything else goes to a human, because these numbers end up in a
 * document shown to a paying brand.
 *
 * A non-null metric with NO confidence entry counts as low confidence — a model
 * that reports a number without scoring it has not earned an auto-accept.
 */
export function routeByConfidence(input: ConfidenceRoutingInput): RoutingDecision {
  const reasons: string[] = [];
  const lowConfidenceFields: MetricKey[] = [];

  // An extraction that found nothing is a failed extraction, not a clean one.
  // Without this guard an unreadable screenshot sails through with every metric
  // null and no reason attached, and shows up in a brand report as a post that
  // reached nobody.
  const capturedCount = METRIC_KEYS.filter((k) => input.metrics[k] !== null).length;
  if (capturedCount === 0) {
    reasons.push('The model read no metrics at all from this image. Check the upload is an Insights panel and is legible.');
  }

  if (input.screenType === 'profile') {
    reasons.push('This looks like a profile page, not a post Insights panel. Profile-level numbers are not this post.');
  } else if (input.screenType === 'unrecognized') {
    reasons.push('The model did not recognise this screen as an Insights panel.');
  }

  for (const key of METRIC_KEYS) {
    if (input.metrics[key] === null) continue;
    const confidence = input.fieldConfidence[key];
    if (confidence === undefined) {
      lowConfidenceFields.push(key);
      reasons.push(`${key} has a value but no confidence score from the model.`);
      continue;
    }
    if (confidence < MIN_FIELD_CONFIDENCE) {
      lowConfidenceFields.push(key);
      reasons.push(
        `${key} confidence ${confidence.toFixed(2)} is below the ${MIN_FIELD_CONFIDENCE} threshold.`,
      );
    }
  }

  for (const violation of input.plausibility.violations) {
    if (violation.severity === 'fail') reasons.push(violation.message);
  }

  return {
    status: reasons.length === 0 ? 'auto_accepted' : 'needs_review',
    reasons,
    lowConfidenceFields,
  };
}
