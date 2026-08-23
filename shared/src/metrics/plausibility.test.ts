import { describe, expect, it } from 'vitest';
import { EMPTY_METRICS, type PostMetrics } from '../types/metrics.js';
import {
  MIN_FIELD_CONFIDENCE,
  PLAUSIBILITY_THRESHOLDS,
  evaluatePlausibility,
  routeByConfidence,
  type PlausibilityInput,
} from './plausibility.js';
import { engagementRate, totalEngagements } from './definitions.js';

const NOW = new Date('2026-03-15T12:00:00.000Z');
const CAMPAIGN_START = new Date('2026-03-01T00:00:00.000Z');
const POSTED_AT = new Date('2026-03-10T09:00:00.000Z');

function metrics(overrides: Partial<PostMetrics>): PostMetrics {
  return { ...EMPTY_METRICS, ...overrides };
}

function input(overrides: Partial<PlausibilityInput> = {}): PlausibilityInput {
  return {
    metrics: metrics({ reach: 10_000, impressions: 12_000, likes: 400, comments: 30, shares: 10, saves: 60 }),
    postedAt: POSTED_AT,
    campaignStartDate: CAMPAIGN_START,
    followerCountAtPost: 8_000,
    now: NOW,
    ...overrides,
  };
}

function rules(result: ReturnType<typeof evaluatePlausibility>): string[] {
  return result.violations.map((v) => v.rule);
}

describe('evaluatePlausibility - the happy path', () => {
  it('passes a realistic micro-creator post', () => {
    const result = evaluatePlausibility(input());
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes a post with only some metrics captured, recording what it skipped', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 5_000, likes: 200 }) }),
    );
    expect(result.passed).toBe(true);
    expect(result.skipped.map((s) => s.rule)).toContain('impressions_below_reach');
  });
});

describe('rule: reach_exceeds_follower_multiple', () => {
  it('fails when reach exceeds followers x 50', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 500_001, impressions: 600_000 }), followerCountAtPost: 10_000 }),
    );
    expect(rules(result)).toContain('reach_exceeds_follower_multiple');
    expect(result.passed).toBe(false);
  });

  it('passes at exactly the multiple, since the rule is strictly greater-than', () => {
    const ceiling = 10_000 * PLAUSIBILITY_THRESHOLDS.reachFollowerMultiple;
    const result = evaluatePlausibility(
      input({
        metrics: metrics({ reach: ceiling, impressions: ceiling, likes: 100 }),
        followerCountAtPost: 10_000,
      }),
    );
    expect(rules(result)).not.toContain('reach_exceeds_follower_multiple');
  });

  it('skips rather than guesses when no follower snapshot exists', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 9_000_000, impressions: 9_000_000 }), followerCountAtPost: null }),
    );
    expect(rules(result)).not.toContain('reach_exceeds_follower_multiple');
    expect(result.skipped.map((s) => s.rule)).toContain('reach_exceeds_follower_multiple');
  });

  it('quotes the follower count as at the post date in its message', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 900_000, impressions: 900_000 }), followerCountAtPost: 1_000 }),
    );
    const violation = result.violations.find((v) => v.rule === 'reach_exceeds_follower_multiple');
    expect(violation?.observed.followerCountAtPost).toBe(1_000);
  });
});

describe('rule: engagement_rate_implausible', () => {
  it('fails above the 25% ceiling', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 1_000, impressions: 1_000, likes: 260 }) }),
    );
    expect(rules(result)).toContain('engagement_rate_implausible');
  });

  it('passes at exactly 25%', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 1_000, impressions: 1_000, likes: 250 }) }),
    );
    expect(rules(result)).not.toContain('engagement_rate_implausible');
  });

  it('uses reach as the denominator, not follower count', () => {
    // 200 engagements over 1,000 reach is 20%, fine. Over 500 followers it
    // would be 40%, which must NOT be what the rule tests.
    const result = evaluatePlausibility(
      input({
        metrics: metrics({ reach: 1_000, impressions: 1_100, likes: 200 }),
        followerCountAtPost: 500,
      }),
    );
    expect(rules(result)).not.toContain('engagement_rate_implausible');
  });

  it('falls back to impressions when reach is absent and says so', () => {
    const m = metrics({ impressions: 1_000, likes: 100 });
    expect(engagementRate(m).basis).toMatch(/impressions/);
    expect(engagementRate(m).value).toBeCloseTo(0.1);
  });

  it('skips when neither reach nor impressions was captured', () => {
    const result = evaluatePlausibility(input({ metrics: metrics({ likes: 500 }) }));
    expect(result.skipped.map((s) => s.rule)).toContain('engagement_rate_implausible');
  });

  it('skips on zero reach rather than dividing by zero', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 0, impressions: 0, likes: 0 }) }),
    );
    expect(Number.isNaN(engagementRate(metrics({ reach: 0, likes: 0 })).value ?? 0)).toBe(false);
    expect(result.skipped.map((s) => s.rule)).toContain('engagement_rate_implausible');
  });
});

describe('rule: impressions_below_reach', () => {
  it('fails when impressions are below reach', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 10_000, impressions: 9_999, likes: 100 }) }),
    );
    expect(rules(result)).toContain('impressions_below_reach');
  });

  it('passes when they are equal', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 10_000, impressions: 10_000, likes: 100 }) }),
    );
    expect(rules(result)).not.toContain('impressions_below_reach');
  });
});

describe('rule: engagements_exceed_impressions', () => {
  it('fails when the engagement sum exceeds impressions', () => {
    const result = evaluatePlausibility(
      input({
        metrics: metrics({ reach: 900, impressions: 1_000, likes: 600, comments: 300, shares: 200, saves: 50 }),
      }),
    );
    expect(rules(result)).toContain('engagements_exceed_impressions');
  });

  it('falls back to reach when impressions were not captured', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 100, likes: 400 }) }),
    );
    const violation = result.violations.find((v) => v.rule === 'engagements_exceed_impressions');
    expect(violation).toBeDefined();
    expect(violation?.observed.reach).toBe(100);
  });

  it('counts all four engagement metrics', () => {
    expect(totalEngagements(metrics({ likes: 1, comments: 2, shares: 3, saves: 4 })).value).toBe(10);
  });

  it('sums only the captured engagement metrics and flags the partial basis', () => {
    const result = totalEngagements(metrics({ likes: 10, comments: 5 }));
    expect(result.value).toBe(15);
    expect(result.basis).toMatch(/partial/);
  });
});

describe('rule: metric_negative_or_non_integer', () => {
  it('fails on a negative value', () => {
    const result = evaluatePlausibility(input({ metrics: metrics({ reach: -1 }) }));
    expect(rules(result)).toContain('metric_negative_or_non_integer');
  });

  it('fails on a fractional value', () => {
    const result = evaluatePlausibility(input({ metrics: metrics({ likes: 10.5 }) }));
    expect(rules(result)).toContain('metric_negative_or_non_integer');
  });

  it('fails on NaN and Infinity', () => {
    expect(rules(evaluatePlausibility(input({ metrics: metrics({ reach: Number.NaN }) })))).toContain(
      'metric_negative_or_non_integer',
    );
    expect(
      rules(evaluatePlausibility(input({ metrics: metrics({ reach: Number.POSITIVE_INFINITY }) }))),
    ).toContain('metric_negative_or_non_integer');
  });

  it('names every offending field, not just the first', () => {
    const result = evaluatePlausibility(input({ metrics: metrics({ reach: -1, likes: 2.5 }) }));
    const violation = result.violations.find((v) => v.rule === 'metric_negative_or_non_integer');
    expect(violation?.fields).toEqual(expect.arrayContaining(['reach', 'likes']));
  });

  it('treats zero as a legitimate value, not as missing', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 500, impressions: 500, likes: 0, comments: 0, shares: 0, saves: 0 }) }),
    );
    expect(result.passed).toBe(true);
  });
});

describe('rules: postedAt', () => {
  it('fails when postedAt is in the future', () => {
    const result = evaluatePlausibility(input({ postedAt: new Date('2026-04-01T00:00:00.000Z') }));
    expect(rules(result)).toContain('posted_at_in_future');
  });

  it('fails when postedAt precedes the campaign start', () => {
    const result = evaluatePlausibility(input({ postedAt: new Date('2026-02-20T00:00:00.000Z') }));
    expect(rules(result)).toContain('posted_at_before_campaign_start');
  });

  it('passes on the campaign start boundary itself', () => {
    const result = evaluatePlausibility(input({ postedAt: CAMPAIGN_START }));
    expect(rules(result)).not.toContain('posted_at_before_campaign_start');
  });
});

describe('evaluatePlausibility - reporting', () => {
  it('reports every independent violation, not just the first', () => {
    const result = evaluatePlausibility(
      input({
        metrics: metrics({ reach: 10_000, impressions: 500, likes: 9_000 }),
        followerCountAtPost: 100,
        postedAt: new Date('2026-02-01T00:00:00.000Z'),
      }),
    );
    expect(rules(result)).toEqual(
      expect.arrayContaining([
        'reach_exceeds_follower_multiple',
        'impressions_below_reach',
        'engagements_exceed_impressions',
        'posted_at_before_campaign_start',
      ]),
    );
  });

  it('never mutates the metrics it was given', () => {
    const original = metrics({ reach: -5, likes: 10.5 });
    const snapshot = { ...original };
    evaluatePlausibility(input({ metrics: original }));
    expect(original).toEqual(snapshot);
  });

  it('carries an operator-readable message on every violation', () => {
    const result = evaluatePlausibility(
      input({ metrics: metrics({ reach: 10_000, impressions: 100, likes: 50 }) }),
    );
    for (const violation of result.violations) {
      expect(violation.message.length).toBeGreaterThan(20);
    }
  });
});

describe('routeByConfidence', () => {
  const clean = evaluatePlausibility(input());

  it('auto-accepts when all fields are confident and plausibility passed', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000, likes: 100 }),
      fieldConfidence: { reach: 0.99, likes: 0.95 },
      plausibility: clean,
    });
    expect(decision.status).toBe('auto_accepted');
    expect(decision.reasons).toHaveLength(0);
  });

  it('routes to review when any field is below the threshold', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000, likes: 100 }),
      fieldConfidence: { reach: 0.99, likes: 0.5 },
      plausibility: clean,
    });
    expect(decision.status).toBe('needs_review');
    expect(decision.lowConfidenceFields).toEqual(['likes']);
  });

  it('accepts exactly at the threshold', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000 }),
      fieldConfidence: { reach: MIN_FIELD_CONFIDENCE },
      plausibility: clean,
    });
    expect(decision.status).toBe('auto_accepted');
  });

  it('treats a value with no confidence score as low confidence', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000 }),
      fieldConfidence: {},
      plausibility: clean,
    });
    expect(decision.status).toBe('needs_review');
    expect(decision.lowConfidenceFields).toEqual(['reach']);
  });

  it('ignores confidence on fields that are null', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000 }),
      fieldConfidence: { reach: 0.99, impressions: 0.1 },
      plausibility: clean,
    });
    expect(decision.status).toBe('auto_accepted');
  });

  it('routes to review on a plausibility failure even at perfect confidence', () => {
    const failed = evaluatePlausibility(
      input({ metrics: metrics({ reach: 10_000, impressions: 5_000, likes: 100 }) }),
    );
    const decision = routeByConfidence({
      metrics: metrics({ reach: 10_000, impressions: 5_000, likes: 100 }),
      fieldConfidence: { reach: 1, impressions: 1, likes: 1 },
      plausibility: failed,
    });
    expect(decision.status).toBe('needs_review');
    expect(decision.reasons.join(' ')).toMatch(/Impressions/);
  });

  it('routes an all-null extraction to review rather than accepting an empty post', () => {
    const decision = routeByConfidence({
      metrics: EMPTY_METRICS,
      fieldConfidence: {},
      plausibility: clean,
    });
    expect(decision.status).toBe('needs_review');
    expect(decision.reasons.join(' ')).toMatch(/no metrics at all/);
  });

  it('routes a profile screenshot to review even when the numbers look clean', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000, likes: 100 }),
      fieldConfidence: { reach: 0.99, likes: 0.99 },
      plausibility: clean,
      screenType: 'profile',
    });
    expect(decision.status).toBe('needs_review');
    expect(decision.reasons.join(' ')).toMatch(/profile page/);
  });

  it('routes an unrecognised screen to review', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000 }),
      fieldConfidence: { reach: 0.99 },
      plausibility: clean,
      screenType: 'unrecognized',
    });
    expect(decision.status).toBe('needs_review');
  });

  it('auto-accepts a recognised post_insights screen', () => {
    const decision = routeByConfidence({
      metrics: metrics({ reach: 1_000, likes: 100 }),
      fieldConfidence: { reach: 0.99, likes: 0.99 },
      plausibility: clean,
      screenType: 'post_insights',
    });
    expect(decision.status).toBe('auto_accepted');
  });
});
