import type { MetricKey, PostFormat, Platform, PostMetrics } from '@anton/shared';

export interface QueueItem {
  id: string;
  campaign: { id: string; name: string; startDate: string | null };
  creator: {
    id: string;
    displayName: string;
    handle: string | null;
    followersAtPost: number | null;
    followersCapturedAt: string | null;
  };
  platform: Platform;
  format: PostFormat;
  postedAt: string;
  submittedAt: string;
  publicUrl: string | null;
  caption: string | null;
  creativeAngleTags: string[];
  hookText: string | null;
  metrics: PostMetrics;
  derived: {
    engagementRate: number | null;
    engagementRateBasis: string;
    totalEngagements: number | null;
  };
  extraction: {
    status: 'pending' | 'auto_accepted' | 'needs_review' | 'verified' | 'rejected';
    model: string;
    promptVersion: string;
    parseOk: boolean;
    parseError: string | null;
    detectedPlatform: string | null;
    detectedScreenType: string | null;
    modelNotes: string | null;
    fieldConfidence: Partial<Record<MetricKey, number | null>>;
    plausibility: {
      passed: boolean;
      violations: {
        rule: string;
        message: string;
        fields: MetricKey[];
        severity: 'fail' | 'warn';
      }[];
      skipped: { rule: string; reason: string }[];
    };
    routingReasons: string[];
    instructionTextDetected: boolean;
    extractedAt: string;
    sourceImageSha256: string;
  } | null;
  trust: {
    submissionLagHours: number | null;
    withinSubmissionWindow: boolean | null;
    exifPresent: boolean | null;
    exifCaptureTimestamp: string | null;
    flaggedForSpotAudit: boolean;
    spotAuditOutcome: string | null;
    publicCrossCheck: { status: string; note: string | null } | null;
    historicalDeviation: {
      creatorMedianEngagementRate: number | null;
      thisEngagementRate: number | null;
      deviationMultiple: number | null;
      exceededThreshold: boolean;
      sampleSize: number;
    } | null;
  } | null;
  screenshotUrl: string | null;
  screenshotUrlExpiresAt: string | null;
  manualOverrides: {
    field: MetricKey;
    from: number | null;
    to: number | null;
    at: string;
    reason: string | null;
  }[];
  verifiedAt: string | null;
  rejectedReason: string | null;
}

export interface QueueResponse {
  items: QueueItem[];
  counts: Record<string, number>;
  metricKeys: MetricKey[];
}

export interface DashboardResponse {
  posts: Record<string, number>;
  instructionTextDetected: number;
  spotAuditsOutstanding: number;
  spend: { days: { dayKey: string; totalMinor: number; extractions: number }[]; todayMinor: number };
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  reach: 'Reach',
  impressions: 'Impressions',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
  profileVisits: 'Profile visits',
  linkClicks: 'Link clicks',
  videoViews: 'Video views',
  watchTimeSeconds: 'Watch time (s)',
  followsFromPost: 'Follows from post',
};
