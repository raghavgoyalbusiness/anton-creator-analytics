import type { Money } from '../types/common.js';
import { ENGAGEMENT_METRIC_KEYS, type PostMetrics } from '../types/metrics.js';

/**
 * Single source of truth for every derived figure.
 *
 * Rule observed throughout: a derived figure is null whenever any input it
 * needs is null. We never substitute zero for an unknown, and we never fall
 * back to a different denominator without saying which one was used.
 */

export interface DerivedFigure<T> {
  readonly value: T | null;
  /** Names the denominator/inputs actually used, for display next to the number. */
  readonly basis: string;
  /** Populated when value is null: why it could not be computed. */
  readonly unavailableReason: string | null;
}

function unavailable<T>(basis: string, reason: string): DerivedFigure<T> {
  return { value: null, basis, unavailableReason: reason };
}

/** likes + comments + shares + saves. Null if every component is null. */
export function totalEngagements(m: PostMetrics): DerivedFigure<number> {
  const present = ENGAGEMENT_METRIC_KEYS.filter((k) => m[k] !== null);
  if (present.length === 0) {
    return unavailable('likes+comments+shares+saves', 'no engagement metric captured');
  }
  const sum = present.reduce((acc, k) => acc + (m[k] ?? 0), 0);
  return {
    value: sum,
    basis:
      present.length === ENGAGEMENT_METRIC_KEYS.length
        ? 'likes+comments+shares+saves'
        : `${present.join('+')} (partial: ${ENGAGEMENT_METRIC_KEYS.filter((k) => m[k] === null).join(', ')} not captured)`,
    unavailableReason: null,
  };
}

/**
 * Engagement rate = total engagements / reach.
 *
 * Reach is the denominator, not follower count. Falls back to impressions only
 * when reach is null, and says so in `basis`. This is the exact figure the
 * `engagement_rate_implausible` plausibility rule tests, by construction.
 */
export function engagementRate(m: PostMetrics): DerivedFigure<number> {
  const engagements = totalEngagements(m);
  if (engagements.value === null) {
    return unavailable('engagements / reach', 'no engagement metric captured');
  }
  const denominator = m.reach ?? m.impressions;
  if (denominator === null) {
    return unavailable('engagements / reach', 'neither reach nor impressions captured');
  }
  if (denominator === 0) {
    return unavailable('engagements / reach', 'reach is zero');
  }
  return {
    value: engagements.value / denominator,
    basis: m.reach !== null ? 'engagements / reach' : 'engagements / impressions (reach not captured)',
    unavailableReason: null,
  };
}

/** Cost per 1,000 reach. Spend in minor units; result in minor units. */
export function costPerThousandReach(spend: Money, totalReach: number | null): DerivedFigure<number> {
  if (totalReach === null) return unavailable('spend / (reach/1000)', 'reach not captured');
  if (totalReach === 0) return unavailable('spend / (reach/1000)', 'reach is zero');
  return {
    value: spend.amountMinor / (totalReach / 1000),
    basis: 'spend / (reach / 1000)',
    unavailableReason: null,
  };
}

/**
 * The headline. The brief calls this "cost per thousand engaged reach".
 *
 * NAMING FLAG for the operator: "engaged reach" is not a quantity either
 * platform exposes — we cannot know how many of the people reached engaged.
 * What is computable is cost per thousand ENGAGEMENTS, which is what this
 * returns, and `basis` labels it as such wherever it is rendered. If you want
 * the report to instead say "engaged reach", we need an agreed proxy and it
 * must be labelled as a proxy.
 */
export function costPerThousandEngagements(
  spend: Money,
  engagements: number | null,
): DerivedFigure<number> {
  if (engagements === null) {
    return unavailable('spend / (engagements/1000)', 'no engagement metric captured');
  }
  if (engagements === 0) {
    return unavailable('spend / (engagements/1000)', 'zero engagements recorded');
  }
  return {
    value: spend.amountMinor / (engagements / 1000),
    basis: 'spend / (engagements / 1000)',
    unavailableReason: null,
  };
}

/** Sum a metric across posts, returning null only when every value is null. */
export function sumMetric(
  posts: readonly PostMetrics[],
  key: keyof PostMetrics,
): DerivedFigure<number> {
  const present = posts.map((p) => p[key]).filter((v): v is number => v !== null);
  if (present.length === 0) return unavailable(String(key), `${String(key)} not captured on any post`);
  return {
    value: present.reduce((a, b) => a + b, 0),
    basis:
      present.length === posts.length
        ? `sum of ${String(key)} across ${posts.length} posts`
        : `sum of ${String(key)} across ${present.length} of ${posts.length} posts (${posts.length - present.length} not captured)`,
    unavailableReason: null,
  };
}

export function formatMoney(money: Money): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  const symbol = symbols[money.currency] ?? `${money.currency} `;
  return `${symbol}${(money.amountMinor / 100).toFixed(2)}`;
}
