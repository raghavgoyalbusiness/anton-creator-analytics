import type { Money } from '../types/common.js';
import type { PostFormat } from '../types/common.js';
import type { PostMetrics } from '../types/metrics.js';
import {
  costPerThousandEngagements,
  costPerThousandReach,
  engagementRate,
  sumMetric,
  totalEngagements,
  type DerivedFigure,
} from './definitions.js';

/**
 * Brand report computation.
 *
 * Lives in shared, beside the plausibility rules, so the figure a brand reads
 * and the figure the tests check are produced by the same code.
 *
 * Two rules run through every function here:
 *  - A figure with a missing input is null and says why. Never zero.
 *  - Nothing is modelled, estimated or extrapolated. If the platforms did not
 *    show it and the brand did not report it, it does not appear.
 */

export interface ReportPost {
  readonly postId: string;
  readonly creatorId: string;
  readonly format: PostFormat;
  readonly platform: string;
  readonly postedAt: Date;
  readonly metrics: PostMetrics;
  readonly creativeAngleTags: readonly string[];
  readonly hookText: string | null;
  /** Provenance, surfaced in the report UI rather than only in the database. */
  readonly metricSource: string;
  readonly extractionStatus: string | null;
}

export interface ReportCreator {
  readonly creatorId: string;
  readonly displayName: string;
  readonly handle: string | null;
  readonly nicheTags: readonly string[];
  readonly followerBand: string;
  readonly followers: number | null;
  readonly agreedRate: Money | null;
}

export interface CampaignSummary {
  readonly creatorsActivated: number;
  readonly postsLive: number;
  readonly totalReach: DerivedFigure<number>;
  readonly totalImpressions: DerivedFigure<number>;
  readonly totalEngagements: DerivedFigure<number>;
  readonly spend: Money;
  readonly costPerThousandReach: DerivedFigure<number>;
  readonly costPerThousandEngagements: DerivedFigure<number>;
  /** How many posts contributed, and how many were excluded and why. */
  readonly coverage: {
    readonly included: number;
    readonly excludedNotVerified: number;
    readonly excludedRejected: number;
  };
}

/**
 * Only posts an operator has signed off, or that auto-accepted, reach a brand.
 * A needs_review post is not a smaller number; it is an unestablished one.
 */
export function isReportable(post: ReportPost): boolean {
  if (post.metricSource !== 'screenshot') return true;
  return post.extractionStatus === 'verified' || post.extractionStatus === 'auto_accepted';
}

export function summariseCampaign(
  allPosts: readonly ReportPost[],
  spend: Money,
  activatedCreatorIds: readonly string[],
): CampaignSummary {
  const included = allPosts.filter(isReportable);
  const metrics = included.map((p) => p.metrics);

  const reach = sumMetric(metrics, 'reach');
  const impressions = sumMetric(metrics, 'impressions');

  const engagementValues = metrics
    .map((m) => totalEngagements(m).value)
    .filter((v): v is number => v !== null);
  const engagements: DerivedFigure<number> =
    engagementValues.length === 0
      ? {
          value: null,
          basis: 'sum of likes+comments+shares+saves',
          unavailableReason: 'no engagement metric captured on any reportable post',
        }
      : {
          value: engagementValues.reduce((a, b) => a + b, 0),
          basis:
            engagementValues.length === included.length
              ? `sum across ${included.length} posts`
              : `sum across ${engagementValues.length} of ${included.length} posts`,
          unavailableReason: null,
        };

  return {
    creatorsActivated: new Set(activatedCreatorIds).size,
    postsLive: included.length,
    totalReach: reach,
    totalImpressions: impressions,
    totalEngagements: engagements,
    spend,
    costPerThousandReach: costPerThousandReach(spend, reach.value),
    costPerThousandEngagements: costPerThousandEngagements(spend, engagements.value),
    coverage: {
      included: included.length,
      excludedNotVerified: allPosts.filter(
        (p) => !isReportable(p) && p.extractionStatus !== 'rejected',
      ).length,
      excludedRejected: allPosts.filter((p) => p.extractionStatus === 'rejected').length,
    },
  };
}

/* ------------------------------------------------------------- comparison */

export interface BenchmarkComparison {
  readonly label: string;
  readonly sourceNote: string;
  readonly enteredAt: Date;
  readonly quotedFee: Money;
  readonly quotedReach: number;
  readonly benchmarkCostPerThousandReach: number;
  readonly campaignCostPerThousandReach: number | null;
  /** How many times cheaper (>1) or dearer (<1) the campaign was. */
  readonly ratio: number | null;
  /**
   * Always true. Present so a renderer cannot show this panel without also
   * carrying the fact that the comparison figure was typed in by Anton.
   */
  readonly isOperatorSuppliedBenchmark: true;
}

export function compareToBenchmark(
  summary: CampaignSummary,
  benchmark: {
    label: string;
    sourceNote: string;
    enteredAt: Date;
    quotedFee: Money;
    quotedReach: number;
  } | null,
): BenchmarkComparison | null {
  if (!benchmark) return null;
  if (benchmark.quotedReach <= 0) return null;

  const benchmarkCpm = benchmark.quotedFee.amountMinor / (benchmark.quotedReach / 1000);
  const campaignCpm = summary.costPerThousandReach.value;

  return {
    label: benchmark.label,
    sourceNote: benchmark.sourceNote,
    enteredAt: benchmark.enteredAt,
    quotedFee: benchmark.quotedFee,
    quotedReach: benchmark.quotedReach,
    benchmarkCostPerThousandReach: benchmarkCpm,
    campaignCostPerThousandReach: campaignCpm,
    ratio: campaignCpm === null || campaignCpm === 0 ? null : benchmarkCpm / campaignCpm,
    isOperatorSuppliedBenchmark: true,
  };
}

/* ------------------------------------------------------------- breakdowns */

export interface GroupPerformance {
  readonly key: string;
  readonly posts: number;
  readonly totalReach: number | null;
  readonly totalEngagements: number | null;
  readonly medianEngagementRate: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
}

function groupBy(
  posts: readonly ReportPost[],
  keyFor: (post: ReportPost) => readonly string[],
): GroupPerformance[] {
  const buckets = new Map<string, ReportPost[]>();
  for (const post of posts) {
    for (const key of keyFor(post)) {
      const list = buckets.get(key) ?? [];
      list.push(post);
      buckets.set(key, list);
    }
  }

  return [...buckets.entries()]
    .map(([key, group]) => {
      const reachValues = group.map((p) => p.metrics.reach).filter((v): v is number => v !== null);
      const engagementValues = group
        .map((p) => totalEngagements(p.metrics).value)
        .filter((v): v is number => v !== null);
      const rates = group
        .map((p) => engagementRate(p.metrics).value)
        .filter((v): v is number => v !== null);

      return {
        key,
        posts: group.length,
        totalReach: reachValues.length > 0 ? reachValues.reduce((a, b) => a + b, 0) : null,
        totalEngagements:
          engagementValues.length > 0 ? engagementValues.reduce((a, b) => a + b, 0) : null,
        medianEngagementRate: median(rates),
      };
    })
    .sort((a, b) => (b.medianEngagementRate ?? -1) - (a.medianEngagementRate ?? -1));
}

/** Performance by creative angle. Median, so one outlier does not crown a tag. */
export function byCreativeAngle(posts: readonly ReportPost[]): GroupPerformance[] {
  return groupBy(posts.filter(isReportable), (p) =>
    p.creativeAngleTags.length > 0 ? p.creativeAngleTags : ['untagged'],
  );
}

export function byFormat(posts: readonly ReportPost[]): GroupPerformance[] {
  return groupBy(posts.filter(isReportable), (p) => [p.format]);
}

export function byNiche(
  posts: readonly ReportPost[],
  creators: readonly ReportCreator[],
): GroupPerformance[] {
  return groupBy(posts.filter(isReportable), (p) => {
    const creator = creators.find((c) => c.creatorId === p.creatorId);
    return creator && creator.nicheTags.length > 0 ? creator.nicheTags : ['unspecified'];
  });
}

export interface TopHook {
  readonly hookText: string;
  readonly creatorId: string;
  readonly postId: string;
  readonly engagementRate: number | null;
  readonly reach: number | null;
}

/** Hooks ranked by engagement rate. Posts without a transcribed hook are absent. */
export function topHooks(posts: readonly ReportPost[], limit = 8): TopHook[] {
  return posts
    .filter(isReportable)
    .filter((p) => p.hookText != null && p.hookText.trim().length > 0)
    .map((p) => ({
      hookText: p.hookText ?? '',
      creatorId: p.creatorId,
      postId: p.postId,
      engagementRate: engagementRate(p.metrics).value,
      reach: p.metrics.reach,
    }))
    .filter((h) => h.engagementRate !== null)
    .sort((a, b) => (b.engagementRate ?? 0) - (a.engagementRate ?? 0))
    .slice(0, limit);
}

/* ------------------------------------------------------------- conversion */

export interface ConversionReport {
  /** null when no brand has reported anything, which is the usual case. */
  readonly reportedRedemptions: number | null;
  readonly reportedRevenue: Money | null;
  readonly reportedBySource: string | null;
  readonly reportedAt: Date | null;
  readonly codesIssued: number;
  readonly codesWithData: number;
  /**
   * The sentence the report must render when there is no conversion data.
   * Kept here rather than in the UI so it cannot drift into something that
   * implies a measurement was made.
   */
  readonly statement: string;
}

export function summariseConversions(
  codes: readonly {
    reportedRedemptions: number | null;
    reportedRevenue: Money | null;
    reportedBySource: string | null;
    reportedAt: Date | null;
  }[],
  currency: Money['currency'],
): ConversionReport {
  const withData = codes.filter((c) => c.reportedRedemptions !== null);

  if (withData.length === 0) {
    return {
      reportedRedemptions: null,
      reportedRevenue: null,
      reportedBySource: null,
      reportedAt: null,
      codesIssued: codes.length,
      codesWithData: 0,
      statement:
        'No conversion data. Anton measures reach and engagement; attributing sales requires discount-code or tracking-link figures from your own commerce platform, which have not been supplied for this campaign.',
    };
  }

  const redemptions = withData.reduce((sum, c) => sum + (c.reportedRedemptions ?? 0), 0);
  const revenueMinor = withData.reduce((sum, c) => sum + (c.reportedRevenue?.amountMinor ?? 0), 0);
  const latest = withData
    .map((c) => c.reportedAt)
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return {
    reportedRedemptions: redemptions,
    reportedRevenue: { amountMinor: revenueMinor, currency },
    reportedBySource: withData.find((c) => c.reportedBySource)?.reportedBySource ?? null,
    reportedAt: latest ?? null,
    codesIssued: codes.length,
    codesWithData: withData.length,
    statement:
      withData.length === codes.length
        ? 'Figures below were supplied by the brand from its own commerce platform. Anton did not measure them.'
        : `Figures below cover ${withData.length} of ${codes.length} codes and were supplied by the brand from its own commerce platform. Anton did not measure them, and codes with no data are not counted as zero.`,
  };
}

/* --------------------------------------------------------------- labelling */

/**
 * How a metric's provenance is described to a brand.
 *
 * Phase 1 numbers are creator-reported with a source image attached. Only
 * OAuth-sourced numbers may be called platform-verified, and the distinction
 * appears in the report itself rather than living only in the database.
 */
export function provenanceLabel(metricSource: string): {
  label: string;
  detail: string;
  isPlatformVerified: boolean;
} {
  switch (metricSource) {
    case 'instagram_oauth':
    case 'tiktok_oauth':
      return {
        label: 'Platform-verified',
        detail: 'Read directly from the platform API with the creator’s authorisation.',
        isPlatformVerified: true,
      };
    case 'manual':
      return {
        label: 'Entered by Anton',
        detail: 'Typed in by an operator. No source image is attached.',
        isPlatformVerified: false,
      };
    default:
      return {
        label: 'Creator-reported, source image attached',
        detail:
          'The creator submitted a screenshot of their own Insights panel. Anton read the numbers from it and a person checked anything uncertain. A screenshot can be edited, so this is evidence rather than platform verification.',
        isPlatformVerified: false,
      };
  }
}
