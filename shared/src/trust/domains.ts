import type { Money } from '../types/common.js';
import { MIN_SAMPLE_FOR_DOMAIN_RATE, SEED_TRUST_DOMAINS } from '../types/commerce.js';
import { roundHalfAwayFromZero } from '../money/currency.js';

/**
 * Trust domains: what an audience comes to a creator FOR.
 *
 * Niche says "skincare". A trust domain says whether that audience trusts the
 * creator on ingredient science or on budget picks — two audiences inside one
 * niche that buy completely differently. It is the most commercially useful
 * tag in the product and the easiest to turn into a false finding, because a
 * per-domain conversion rate computed from a handful of orders looks exactly
 * as authoritative as one computed from a thousand.
 *
 * So the rule here is blunt: below MIN_SAMPLE_FOR_DOMAIN_RATE attributed
 * orders, no rate is reported at all. Not a rate with a caveat — no rate. A
 * brand will act on the number and ignore the footnote.
 */

export const TRUST_DOMAIN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  routine_technique: 'Routine and technique',
  ingredient_science: 'Ingredient science',
  budget_picks: 'Budget picks',
  sensitive_skin: 'Sensitive skin',
  transformation: 'Transformation',
  clinical_authority: 'Clinical authority',
  lifestyle_adjacent: 'Lifestyle adjacent',
});

export const MAX_TRUST_DOMAINS_PER_CREATOR = 3;

/**
 * Folds an operator-typed domain onto a stable key.
 *
 * Custom values are allowed — the seed list will not cover every audience —
 * but "Budget Picks", "budget-picks" and " budget picks " must be one domain,
 * or the breakdown splits a real signal into three samples that are each too
 * small to report.
 */
export function normaliseTrustDomain(raw: string): string | null {
  const key = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (key.length < 3 || key.length > 40) return null;
  return key;
}

export function labelForTrustDomain(key: string): string {
  const seeded = TRUST_DOMAIN_LABELS[key];
  if (seeded) return seeded;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function isSeedTrustDomain(key: string): boolean {
  return (SEED_TRUST_DOMAINS as readonly string[]).includes(key);
}

export interface TrustDomainValidation {
  readonly ok: boolean;
  readonly domains: readonly string[];
  readonly problems: readonly string[];
}

/**
 * Validates a creator's full set of domains.
 *
 * Capped at three. A creator tagged with seven domains is a creator nobody
 * made a judgement about, and every one of those tags dilutes the others in
 * the breakdown.
 */
export function validateTrustDomains(raw: readonly string[]): TrustDomainValidation {
  const problems: string[] = [];
  const domains: string[] = [];

  for (const value of raw) {
    const key = normaliseTrustDomain(value);
    if (!key) {
      problems.push(`"${value}" is not a usable domain name`);
      continue;
    }
    if (!domains.includes(key)) domains.push(key);
  }

  if (domains.length > MAX_TRUST_DOMAINS_PER_CREATOR) {
    problems.push(
      `a creator can carry at most ${MAX_TRUST_DOMAINS_PER_CREATOR} trust domains; pick the ones their audience actually comes for`,
    );
  }

  return { ok: problems.length === 0, domains, problems };
}

/* ------------------------------------------------------------ breakdown */

export interface DomainOrderInput {
  /** Domains of the creator the order was attributed to. */
  readonly creatorDomains: readonly string[];
  readonly creatorId: string;
  readonly revenue: Money;
}

export interface DomainCreatorInput {
  readonly creatorId: string;
  readonly domains: readonly string[];
  /** Reach across this creator's posts, or null when not captured. */
  readonly reach: number | null;
}

export interface DomainPerformance {
  readonly domain: string;
  readonly label: string;
  readonly isSeed: boolean;
  readonly creators: number;
  readonly orders: number;
  readonly revenue: Money;
  /**
   * Attributed orders per thousand people reached.
   *
   * Null in two different situations, and `rateUnavailableReason` says which:
   * too few orders to mean anything, or no reach captured to divide by.
   */
  readonly ordersPerThousandReach: number | null;
  readonly revenuePerCreator: Money | null;
  readonly rateUnavailableReason: string | null;
  readonly sampleSufficient: boolean;
}

export interface DomainBreakdown {
  readonly minimumSample: number;
  readonly domains: readonly DomainPerformance[];
  readonly untaggedCreators: number;
  readonly untaggedOrders: number;
  /** Always rendered beside the breakdown. */
  readonly statement: string;
}

/**
 * Performance by trust domain.
 *
 * A creator tagged with two domains counts towards both. That double-counts
 * across domains on purpose — the question is "how do creators trusted for X
 * perform", not "what share of revenue belongs to X" — and so the domain
 * revenues are never summed or shown as shares of a whole.
 */
export function breakdownByTrustDomain(
  creators: readonly DomainCreatorInput[],
  orders: readonly DomainOrderInput[],
  currency: string,
  minimumSample = MIN_SAMPLE_FOR_DOMAIN_RATE,
): DomainBreakdown {
  type Bucket = { creators: Set<string>; orders: number; revenue: number; reach: number; reachKnown: boolean };
  const buckets = new Map<string, Bucket>();
  const bucketFor = (domain: string): Bucket => {
    const existing = buckets.get(domain);
    if (existing) return existing;
    const made: Bucket = { creators: new Set(), orders: 0, revenue: 0, reach: 0, reachKnown: false };
    buckets.set(domain, made);
    return made;
  };

  let untaggedCreators = 0;
  for (const creator of creators) {
    if (creator.domains.length === 0) {
      untaggedCreators += 1;
      continue;
    }
    for (const domain of creator.domains) {
      const b = bucketFor(domain);
      b.creators.add(creator.creatorId);
      if (creator.reach !== null) {
        b.reach += creator.reach;
        b.reachKnown = true;
      }
    }
  }

  let untaggedOrders = 0;
  for (const order of orders) {
    if (order.creatorDomains.length === 0) {
      untaggedOrders += 1;
      continue;
    }
    for (const domain of order.creatorDomains) {
      const b = bucketFor(domain);
      b.creators.add(order.creatorId);
      b.orders += 1;
      b.revenue += order.revenue.amountMinor;
    }
  }

  const domains: DomainPerformance[] = [...buckets.entries()]
    .map(([domain, b]) => {
      const sampleSufficient = b.orders >= minimumSample;

      let rate: number | null = null;
      let reason: string | null = null;
      if (!sampleSufficient) {
        reason = `${b.orders} attributed ${b.orders === 1 ? 'order' : 'orders'}; a rate is only reported from ${minimumSample}`;
      } else if (!b.reachKnown || b.reach <= 0) {
        reason = 'no reach was captured for these creators, so there is nothing to divide by';
      } else {
        rate = (b.orders / b.reach) * 1_000;
      }

      return {
        domain,
        label: labelForTrustDomain(domain),
        isSeed: isSeedTrustDomain(domain),
        creators: b.creators.size,
        orders: b.orders,
        revenue: { amountMinor: b.revenue, currency },
        ordersPerThousandReach: rate,
        revenuePerCreator:
          sampleSufficient && b.creators.size > 0
            ? { amountMinor: roundHalfAwayFromZero(b.revenue / b.creators.size), currency }
            : null,
        rateUnavailableReason: reason,
        sampleSufficient,
      };
    })
    // Reportable domains first, then by orders: a small sample must not
    // outrank a real finding just because its revenue happens to be higher.
    .sort((a, b) =>
      a.sampleSufficient === b.sampleSufficient ? b.orders - a.orders : a.sampleSufficient ? -1 : 1,
    );

  const reportable = domains.filter((d) => d.sampleSufficient).length;

  return {
    minimumSample,
    domains,
    untaggedCreators,
    untaggedOrders,
    statement:
      domains.length === 0
        ? 'No creators on this campaign have been tagged with a trust domain, so there is no breakdown.'
        : reportable === 0
          ? `No trust domain has reached ${minimumSample} attributed orders yet, so no rates are shown. Order counts are shown so you can see where the sample is building.`
          : `Rates are shown only for domains with at least ${minimumSample} attributed orders. A creator tagged with two domains counts towards both, so these figures do not add up to the campaign total and are not shares of it.`,
  };
}
