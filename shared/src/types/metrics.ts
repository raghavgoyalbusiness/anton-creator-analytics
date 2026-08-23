import type { PostFormat } from './common.js';

/**
 * The canonical metric vocabulary. This list is the single source of truth:
 * the vision prompt, the zod validators, the Mongoose schema, the review queue
 * and the brand report all derive from it. Adding a metric means adding it here.
 */
export const METRIC_KEYS = [
  'reach',
  'impressions',
  'likes',
  'comments',
  'shares',
  'saves',
  'profileVisits',
  'linkClicks',
  'videoViews',
  'watchTimeSeconds',
  'followsFromPost',
] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

/**
 * Every metric is nullable. Not every format exposes every metric, and a
 * creator's screenshot may crop one out. `null` means "not known", never zero.
 * Zero is a real, meaningful value and must stay distinguishable from absence.
 */
export type PostMetrics = { readonly [K in MetricKey]: number | null };

export const EMPTY_METRICS: PostMetrics = Object.freeze(
  Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as Record<MetricKey, null>,
);

/**
 * The four metrics that constitute an "engagement". Used by the engagement-rate
 * definition and by the brand report's headline cost figure. Kept in one place
 * so the number in the report and the number the plausibility check tests are
 * provably the same number.
 */
export const ENGAGEMENT_METRIC_KEYS = ['likes', 'comments', 'shares', 'saves'] as const;
export type EngagementMetricKey = (typeof ENGAGEMENT_METRIC_KEYS)[number];

/**
 * Which metrics a given format actually exposes in the native Insights panel.
 * Used to (a) tell the review queue that a null is expected rather than missed,
 * and (b) stop the vision prompt from hallucinating a field the screen cannot
 * contain. Best-effort as of Instagram/TikTok's 2026 panels; edit freely.
 */
export const METRICS_BY_FORMAT: Readonly<Record<PostFormat, readonly MetricKey[]>> = Object.freeze({
  reel: [
    'reach',
    'impressions',
    'likes',
    'comments',
    'shares',
    'saves',
    'profileVisits',
    'videoViews',
    'watchTimeSeconds',
    'followsFromPost',
  ],
  story: ['reach', 'impressions', 'likes', 'shares', 'profileVisits', 'linkClicks', 'followsFromPost'],
  feed: ['reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'profileVisits', 'followsFromPost'],
  carousel: ['reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'profileVisits', 'followsFromPost'],
  tiktok_video: [
    'reach',
    'impressions',
    'likes',
    'comments',
    'shares',
    'saves',
    'profileVisits',
    'videoViews',
    'watchTimeSeconds',
    'followsFromPost',
  ],
});

export function isMetricKey(value: string): value is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(value);
}

export function metricIsExpectedForFormat(format: PostFormat, key: MetricKey): boolean {
  return METRICS_BY_FORMAT[format].includes(key);
}
