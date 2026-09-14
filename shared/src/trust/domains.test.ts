import { describe, expect, it } from 'vitest';
import {
  MAX_TRUST_DOMAINS_PER_CREATOR,
  breakdownByTrustDomain,
  labelForTrustDomain,
  normaliseTrustDomain,
  validateTrustDomains,
  type DomainCreatorInput,
  type DomainOrderInput,
} from './domains.js';
import { MIN_SAMPLE_FOR_DOMAIN_RATE } from '../types/commerce.js';

const GBP = 'GBP';

function orders(n: number, creatorId: string, domains: string[], each = 5_000): DomainOrderInput[] {
  return Array.from({ length: n }, () => ({
    creatorId,
    creatorDomains: domains,
    revenue: { amountMinor: each, currency: GBP },
  }));
}

describe('normaliseTrustDomain', () => {
  it('folds case, spacing, punctuation and accents onto one key', () => {
    for (const raw of ['Budget Picks', 'budget-picks', '  budget picks  ', 'BUDGET_PICKS', 'búdget picks']) {
      expect(normaliseTrustDomain(raw)).toBe('budget_picks');
    }
  });

  it('rejects something too short or too long to be a domain', () => {
    expect(normaliseTrustDomain('ab')).toBeNull();
    expect(normaliseTrustDomain('!!!')).toBeNull();
    expect(normaliseTrustDomain('x'.repeat(41))).toBeNull();
  });
});

describe('labelForTrustDomain', () => {
  it('uses the seeded label when there is one', () => {
    expect(labelForTrustDomain('ingredient_science')).toBe('Ingredient science');
  });

  it('builds a readable label for a custom domain', () => {
    expect(labelForTrustDomain('vegan_swaps')).toBe('Vegan swaps');
  });
});

describe('validateTrustDomains', () => {
  it('dedupes values that fold to the same key', () => {
    const r = validateTrustDomains(['Budget Picks', 'budget-picks', 'Sensitive skin']);
    expect(r.ok).toBe(true);
    expect(r.domains).toEqual(['budget_picks', 'sensitive_skin']);
  });

  it('caps a creator at three domains', () => {
    const r = validateTrustDomains(['one_domain', 'two_domain', 'three_domain', 'four_domain']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain(`at most ${MAX_TRUST_DOMAINS_PER_CREATOR}`);
  });

  it('reports an unusable value by name', () => {
    const r = validateTrustDomains(['ok_domain', '??']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toContain('"??"');
  });

  it('accepts an empty set, which is how a tag is removed', () => {
    expect(validateTrustDomains([])).toEqual({ ok: true, domains: [], problems: [] });
  });
});

/**
 * The rule the module exists for: below the minimum sample, no rate at all.
 * Not a rate with a caveat. A brand acts on the number and ignores the note.
 */
describe('minimum sample', () => {
  it('reports no rate below the threshold, however good it looks', () => {
    const creators: DomainCreatorInput[] = [{ creatorId: 'a', domains: ['budget_picks'], reach: 1_000 }];
    const r = breakdownByTrustDomain(creators, orders(3, 'a', ['budget_picks']), GBP);
    const d = r.domains[0];

    expect(d?.orders).toBe(3);
    expect(d?.sampleSufficient).toBe(false);
    expect(d?.ordersPerThousandReach).toBeNull();
    expect(d?.revenuePerCreator).toBeNull();
    expect(d?.rateUnavailableReason).toContain(`from ${MIN_SAMPLE_FOR_DOMAIN_RATE}`);
  });

  it('reports a rate exactly at the threshold', () => {
    const creators: DomainCreatorInput[] = [{ creatorId: 'a', domains: ['budget_picks'], reach: 50_000 }];
    const r = breakdownByTrustDomain(
      creators,
      orders(MIN_SAMPLE_FOR_DOMAIN_RATE, 'a', ['budget_picks']),
      GBP,
    );
    const d = r.domains[0];
    expect(d?.sampleSufficient).toBe(true);
    // 25 orders per 50,000 reach = 0.5 per thousand
    expect(d?.ordersPerThousandReach).toBe(0.5);
  });

  it('distinguishes "too few orders" from "no reach to divide by"', () => {
    const creators: DomainCreatorInput[] = [{ creatorId: 'a', domains: ['budget_picks'], reach: null }];
    const r = breakdownByTrustDomain(creators, orders(30, 'a', ['budget_picks']), GBP);
    expect(r.domains[0]?.ordersPerThousandReach).toBeNull();
    expect(r.domains[0]?.rateUnavailableReason).toContain('no reach');
    // Revenue per creator does not need reach, so it is still reported.
    expect(r.domains[0]?.revenuePerCreator?.amountMinor).toBe(150_000);
  });

  it('still shows the order count below threshold, so the sample is visible building', () => {
    const creators: DomainCreatorInput[] = [{ creatorId: 'a', domains: ['sensitive_skin'], reach: 10_000 }];
    const r = breakdownByTrustDomain(creators, orders(12, 'a', ['sensitive_skin']), GBP);
    expect(r.domains[0]?.orders).toBe(12);
    expect(r.statement).toContain('where the sample is building');
  });
});

describe('the breakdown', () => {
  it('counts a two-domain creator towards both, and says the figures do not add up', () => {
    const creators: DomainCreatorInput[] = [
      { creatorId: 'a', domains: ['budget_picks', 'routine_technique'], reach: 100_000 },
    ];
    const r = breakdownByTrustDomain(creators, orders(30, 'a', ['budget_picks', 'routine_technique']), GBP);
    expect(r.domains).toHaveLength(2);
    for (const d of r.domains) expect(d.orders).toBe(30);
    expect(r.statement).toContain('do not add up');
  });

  it('ranks reportable domains above small samples regardless of revenue', () => {
    const creators: DomainCreatorInput[] = [
      { creatorId: 'a', domains: ['budget_picks'], reach: 100_000 },
      { creatorId: 'b', domains: ['clinical_authority'], reach: 100_000 },
    ];
    const r = breakdownByTrustDomain(
      creators,
      [
        ...orders(30, 'a', ['budget_picks'], 1_000),
        // Fewer orders, far more revenue: must not outrank a real finding.
        ...orders(5, 'b', ['clinical_authority'], 100_000),
      ],
      GBP,
    );
    expect(r.domains.map((d) => d.domain)).toEqual(['budget_picks', 'clinical_authority']);
  });

  it('counts untagged creators and their orders rather than dropping them', () => {
    const creators: DomainCreatorInput[] = [
      { creatorId: 'a', domains: ['budget_picks'], reach: 1_000 },
      { creatorId: 'b', domains: [], reach: 1_000 },
    ];
    const r = breakdownByTrustDomain(
      creators,
      [...orders(2, 'a', ['budget_picks']), ...orders(4, 'b', [])],
      GBP,
    );
    expect(r.untaggedCreators).toBe(1);
    expect(r.untaggedOrders).toBe(4);
  });

  it('includes a tagged creator with no orders in the creator count', () => {
    const creators: DomainCreatorInput[] = [
      { creatorId: 'a', domains: ['budget_picks'], reach: 1_000 },
      { creatorId: 'b', domains: ['budget_picks'], reach: 1_000 },
    ];
    const r = breakdownByTrustDomain(creators, orders(1, 'a', ['budget_picks']), GBP);
    expect(r.domains[0]?.creators).toBe(2);
  });

  it('marks custom domains as not seeded', () => {
    const r = breakdownByTrustDomain(
      [{ creatorId: 'a', domains: ['vegan_swaps'], reach: 1 }],
      [],
      GBP,
    );
    expect(r.domains[0]?.isSeed).toBe(false);
    expect(r.domains[0]?.label).toBe('Vegan swaps');
  });

  it('says so when nothing is tagged', () => {
    const r = breakdownByTrustDomain([{ creatorId: 'a', domains: [], reach: 1 }], [], GBP);
    expect(r.domains).toEqual([]);
    expect(r.statement).toContain('No creators on this campaign have been tagged');
  });

  it('honours a custom minimum', () => {
    const r = breakdownByTrustDomain(
      [{ creatorId: 'a', domains: ['budget_picks'], reach: 10_000 }],
      orders(5, 'a', ['budget_picks']),
      GBP,
      5,
    );
    expect(r.minimumSample).toBe(5);
    expect(r.domains[0]?.sampleSufficient).toBe(true);
  });
});
