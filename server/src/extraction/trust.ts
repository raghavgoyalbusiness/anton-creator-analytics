import type { PostMetrics } from '@anton/shared';
import { engagementRate } from '@anton/shared';
import { loadEnv } from '../config/env.js';

/**
 * Trust signals beyond the numbers themselves.
 *
 * None of these decide anything. They are evidence an operator weighs, and they
 * exist because a screenshot is forgeable and the product must not pretend
 * otherwise.
 */

export interface HistoricalDeviation {
  readonly creatorMedianEngagementRate: number | null;
  readonly thisEngagementRate: number | null;
  readonly deviationMultiple: number | null;
  readonly exceededThreshold: boolean;
  readonly sampleSize: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  return lower !== undefined && upper !== undefined ? (lower + upper) / 2 : null;
}

/**
 * Compares this post's engagement rate against the creator's own rolling
 * median. Deliberately per-creator, not against a global baseline: a nano
 * creator legitimately runs at 3x the engagement rate of a 70k account, and a
 * global threshold would flag every small creator as suspicious.
 *
 * Needs at least three prior posts. Below that a "median" is noise, and
 * flagging on it would train the operator to ignore the signal.
 */
export function assessHistoricalDeviation(
  thisPost: PostMetrics,
  priorPosts: readonly PostMetrics[],
): HistoricalDeviation {
  const env = loadEnv();
  const thisRate = engagementRate(thisPost).value;

  const priorRates = priorPosts
    .map((p) => engagementRate(p).value)
    .filter((r): r is number => r !== null && r > 0);

  const creatorMedian = priorRates.length >= 3 ? median(priorRates) : null;

  if (thisRate === null || creatorMedian === null || creatorMedian === 0) {
    return {
      creatorMedianEngagementRate: creatorMedian,
      thisEngagementRate: thisRate,
      deviationMultiple: null,
      exceededThreshold: false,
      sampleSize: priorRates.length,
    };
  }

  // Symmetric: a post at a third of the creator's median is as odd as one at
  // three times it, and both are worth a look.
  const ratio = thisRate / creatorMedian;
  const deviationMultiple = ratio >= 1 ? ratio : 1 / ratio;

  return {
    creatorMedianEngagementRate: creatorMedian,
    thisEngagementRate: thisRate,
    deviationMultiple,
    exceededThreshold: deviationMultiple > env.HISTORICAL_DEVIATION_MULTIPLE,
    sampleSize: priorRates.length,
  };
}

export interface PublicCrossCheck {
  readonly status: 'matched' | 'diverged' | 'unavailable' | 'blocked' | 'not_attempted';
  readonly checkedAt: Date | null;
  readonly publicLikes: number | null;
  readonly publicComments: number | null;
  readonly divergenceRatio: number | null;
  readonly note: string | null;
}

export const CROSS_CHECK_NOT_ATTEMPTED: PublicCrossCheck = {
  status: 'not_attempted',
  checkedAt: null,
  publicLikes: null,
  publicComments: null,
  divergenceRatio: null,
  note: null,
};

/**
 * Best-effort public cross-check of the creator's own submitted post URL.
 *
 * Scope is deliberately one URL, the one the creator gave us. No profile
 * crawling, no discovery, no automated collection beyond this single page.
 *
 * Expect this to return 'blocked' or 'unavailable' most of the time. Instagram
 * and TikTok serve login walls and bot challenges to server-side fetches, and
 * neither exposes counts in the HTML they return to one. It is built to be
 * honest about that rather than to manufacture a comparison: an unavailable
 * check is recorded as unavailable and changes nothing about the post's
 * standing. It can corroborate; it can never be relied on.
 */
export async function crossCheckPublicPost(
  publicUrl: string | null,
  submitted: PostMetrics,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicCrossCheck> {
  const env = loadEnv();
  if (env.PUBLIC_CROSSCHECK_ENABLED !== 'true') return CROSS_CHECK_NOT_ATTEMPTED;
  if (!publicUrl) {
    return { ...CROSS_CHECK_NOT_ATTEMPTED, status: 'unavailable', note: 'No public URL was submitted.' };
  }

  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return { ...CROSS_CHECK_NOT_ATTEMPTED, status: 'unavailable', note: 'The submitted URL is malformed.' };
  }
  // Only the two platforms we track, and only their canonical hosts. This is a
  // deliberate allowlist: without it, the submitted URL is a server-side
  // request forgery vector pointed at whatever the creator likes.
  const allowed = ['instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com'];
  if (!allowed.includes(host)) {
    return {
      ...CROSS_CHECK_NOT_ATTEMPTED,
      status: 'unavailable',
      note: `Cross-check only runs against Instagram and TikTok post URLs, not ${host}.`,
    };
  }

  const checkedAt = new Date();
  let html: string;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    const response = await fetchImpl(publicUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'AntonCreatorAnalytics/1.0 (+campaign verification)' },
    });
    clearTimeout(timeout);

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      return {
        status: 'blocked',
        checkedAt,
        publicLikes: null,
        publicComments: null,
        divergenceRatio: null,
        note: `The platform refused the request (${response.status}). This is the normal outcome and is not a signal about the post.`,
      };
    }
    if (!response.ok) {
      return {
        status: 'unavailable',
        checkedAt,
        publicLikes: null,
        publicComments: null,
        divergenceRatio: null,
        note: `The page returned ${response.status}.`,
      };
    }
    html = await response.text();
  } catch {
    return {
      status: 'unavailable',
      checkedAt,
      publicLikes: null,
      publicComments: null,
      divergenceRatio: null,
      note: 'The request timed out or the network refused it.',
    };
  }

  const counts = readPublicCounts(html);
  if (counts.likes === null && counts.comments === null) {
    return {
      status: 'unavailable',
      checkedAt,
      publicLikes: null,
      publicComments: null,
      divergenceRatio: null,
      note: 'The page loaded but exposed no counts, which is usual behind a login wall.',
    };
  }

  const submittedLikes = submitted.likes;
  if (counts.likes === null || submittedLikes === null || submittedLikes === 0) {
    return {
      status: 'unavailable',
      checkedAt,
      publicLikes: counts.likes,
      publicComments: counts.comments,
      divergenceRatio: null,
      note: 'Not enough on both sides to compare.',
    };
  }

  const ratio = counts.likes / submittedLikes;
  const divergence = ratio >= 1 ? ratio : 1 / ratio;
  // Public counts drift from panel counts legitimately — the panel is a
  // snapshot, the page is live, and a post keeps accruing. 2x is the point at
  // which drift stops being a plausible explanation.
  const diverged = divergence > 2;

  return {
    status: diverged ? 'diverged' : 'matched',
    checkedAt,
    publicLikes: counts.likes,
    publicComments: counts.comments,
    divergenceRatio: Math.round(divergence * 100) / 100,
    note: diverged
      ? `Public page shows ${counts.likes.toLocaleString()} likes against ${submittedLikes.toLocaleString()} submitted.`
      : 'Public counts are consistent with the submitted figures.',
  };
}

/** Pulls counts out of whatever metadata the page happens to expose. */
function readPublicCounts(html: string): { likes: number | null; comments: number | null } {
  const likeMatch = /"likeCount"\s*:\s*"?(\d+)"?/.exec(html) ?? /(\d[\d,]*)\s+likes/i.exec(html);
  const commentMatch =
    /"commentCount"\s*:\s*"?(\d+)"?/.exec(html) ?? /(\d[\d,]*)\s+comments/i.exec(html);

  const toNumber = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const n = Number(raw.replace(/,/g, ''));
    return Number.isInteger(n) && n >= 0 ? n : null;
  };

  return { likes: toNumber(likeMatch?.[1]), comments: toNumber(commentMatch?.[1]) };
}
