import { describe, expect, it } from 'vitest';
import { bpsAsPercent, summariseRevenue, type RevenueInput } from './revenue.js';

const GBP = 'GBP';
const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day, 12, 0, 0));

function order(over: Partial<RevenueInput> = {}): RevenueInput {
  const total = over.total ?? { amountMinor: 10_000, currency: GBP };
  return {
    orderId: 'o1',
    orderedAt: AUG(5),
    total,
    subtotal: over.subtotal ?? total,
    status: 'confirmed',
    refundedAmount: null,
    customerType: 'new',
    attribution: null,
    unattributedReason: null,
    ...over,
  };
}

function attributed(
  method: 'code_redemption' | 'link_last_touch' | 'manual_assignment',
  commissionMinor: number,
  over: Partial<RevenueInput> = {},
): RevenueInput {
  return order({
    ...over,
    attribution: {
      creatorId: 'c1',
      method,
      confidence: method === 'link_last_touch' ? 'inferred' : 'direct',
      commission: { amountMinor: commissionMinor, currency: GBP },
    },
  });
}

describe('coverage is reported, never hidden', () => {
  it('counts attributed and unattributed orders side by side', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1_000, { orderId: 'a' }),
        attributed('code_redemption', 1_000, { orderId: 'b' }),
        order({ orderId: 'c', unattributedReason: 'no code and no tracked link on the order' }),
      ],
      GBP,
    );
    expect(r.ordersSeen).toBe(3);
    expect(r.ordersAttributed).toBe(2);
    expect(r.ordersUnattributed).toBe(1);
    // The three must reconcile, or the report is arithmetic nobody can follow.
    expect(r.ordersAttributed + r.ordersUnattributed).toBe(r.ordersSeen);
  });

  it('reports unattributed revenue as a figure, not as an omission', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 500, { orderId: 'a', total: { amountMinor: 5_000, currency: GBP } }),
        order({ orderId: 'b', total: { amountMinor: 20_000, currency: GBP } }),
      ],
      GBP,
    );
    expect(r.attributedRevenue.amountMinor).toBe(5_000);
    expect(r.unattributedRevenue.amountMinor).toBe(20_000);
    expect(r.totalRevenueSeen.amountMinor).toBe(25_000);
    // The parts sum to the whole.
    expect(r.attributedRevenue.amountMinor + r.unattributedRevenue.amountMinor).toBe(
      r.totalRevenueSeen.amountMinor,
    );
  });

  it('states coverage in words, naming both halves', () => {
    const r = summariseRevenue(
      [attributed('code_redemption', 100, { orderId: 'a' }), order({ orderId: 'b' })],
      GBP,
    );
    expect(r.statements.coverage).toContain('1 of 2');
    expect(r.statements.coverage).toContain('no code or link');
  });

  it('computes coverage in basis points', () => {
    const orders = [
      ...Array.from({ length: 58 }, (_, i) => attributed('code_redemption', 10, { orderId: `a${i}` })),
      ...Array.from({ length: 42 }, (_, i) => order({ orderId: `u${i}` })),
    ];
    const r = summariseRevenue(orders, GBP);
    expect(r.coverageBps).toBe(5_800);
    expect(bpsAsPercent(r.coverageBps)).toBe('58.0%');
  });

  it('groups the reasons orders could not be matched', () => {
    const r = summariseRevenue(
      [
        order({ orderId: 'a', unattributedReason: 'no code and no tracked link on the order' }),
        order({ orderId: 'b', unattributedReason: 'no code and no tracked link on the order' }),
        order({ orderId: 'c', unattributedReason: 'the code is not one Anton issued' }),
      ],
      GBP,
    );
    expect(r.unattributedReasons).toEqual([
      { reason: 'no code and no tracked link on the order', orders: 2 },
      { reason: 'the code is not one Anton issued', orders: 1 },
    ]);
  });
});

/**
 * The breakdown is the point. "£41,000 attributed" means something entirely
 * different when it is code redemptions than when it is link clicks.
 */
describe('the method breakdown is always present', () => {
  it('splits by method with a share of ATTRIBUTED revenue', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 750, { orderId: 'a', total: { amountMinor: 7_500, currency: GBP } }),
        attributed('link_last_touch', 250, { orderId: 'b', total: { amountMinor: 2_500, currency: GBP } }),
        // An unattributed order must not dilute the shares.
        order({ orderId: 'c', total: { amountMinor: 90_000, currency: GBP } }),
      ],
      GBP,
    );
    const code = r.byMethod.find((m) => m.method === 'code_redemption');
    const link = r.byMethod.find((m) => m.method === 'link_last_touch');

    expect(code?.shareOfAttributedBps).toBe(7_500);
    expect(link?.shareOfAttributedBps).toBe(2_500);
    // Shares of attributed revenue sum to 100%.
    expect(r.byMethod.reduce((n, m) => n + m.shareOfAttributedBps, 0)).toBe(10_000);
  });

  it('labels a link as inferred and a code as direct', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 100, { orderId: 'a' }),
        attributed('link_last_touch', 100, { orderId: 'b' }),
        attributed('manual_assignment', 100, { orderId: 'c' }),
      ],
      GBP,
    );
    expect(r.byMethod.find((m) => m.method === 'code_redemption')?.confidence).toBe('direct');
    expect(r.byMethod.find((m) => m.method === 'link_last_touch')?.confidence).toBe('inferred');
    expect(r.byMethod.find((m) => m.method === 'manual_assignment')?.confidence).toBe('direct');
  });

  it('carries an explanation for every method, not just a label', () => {
    const r = summariseRevenue([attributed('link_last_touch', 100)], GBP);
    const link = r.byMethod[0];
    expect(link?.explanation).toContain('correlation');
    expect(link?.explanation).toContain('not proof');
  });

  it('warns in words when inferred attribution carries real weight', () => {
    const r = summariseRevenue(
      [
        attributed('link_last_touch', 300, { orderId: 'a', total: { amountMinor: 3_000, currency: GBP } }),
        attributed('code_redemption', 700, { orderId: 'b', total: { amountMinor: 7_000, currency: GBP } }),
      ],
      GBP,
    );
    expect(r.statements.method).toContain('30.0%');
    expect(r.statements.method).toContain('tracked link');
  });

  it('says so plainly when everything came from a typed code', () => {
    const r = summariseRevenue([attributed('code_redemption', 100)], GBP);
    expect(r.statements.method).toContain('strongest signal');
    expect(r.statements.method).not.toContain('%');
  });

  it('sorts the breakdown by revenue, largest first', () => {
    const r = summariseRevenue(
      [
        attributed('link_last_touch', 10, { orderId: 'a', total: { amountMinor: 1_000, currency: GBP } }),
        attributed('code_redemption', 90, { orderId: 'b', total: { amountMinor: 9_000, currency: GBP } }),
      ],
      GBP,
    );
    expect(r.byMethod.map((m) => m.method)).toEqual(['code_redemption', 'link_last_touch']);
  });
});

describe('refunds', () => {
  it('reports gross and net separately rather than substituting one for the other', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1_000, {
          orderId: 'a',
          total: { amountMinor: 10_000, currency: GBP },
        }),
        attributed('code_redemption', 1_000, {
          orderId: 'b',
          total: { amountMinor: 10_000, currency: GBP },
          status: 'refunded',
          refundedAmount: { amountMinor: 10_000, currency: GBP },
        }),
      ],
      GBP,
    );
    // Gross reconciles with the brand's own dashboard; net says what stuck.
    expect(r.attributedRevenue.amountMinor).toBe(20_000);
    expect(r.attributedRevenueNetOfRefunds.amountMinor).toBe(10_000);
    expect(r.refundedOrders).toBe(1);
    expect(r.refundedValue.amountMinor).toBe(10_000);
  });

  it('counts a refund on an unattributed order in the refund figure but not in net attributed', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1_000, {
          orderId: 'a',
          total: { amountMinor: 10_000, currency: GBP },
        }),
        order({
          orderId: 'b',
          total: { amountMinor: 8_000, currency: GBP },
          refundedAmount: { amountMinor: 8_000, currency: GBP },
        }),
      ],
      GBP,
    );
    expect(r.refundedValue.amountMinor).toBe(8_000);
    expect(r.attributedRevenueNetOfRefunds.amountMinor).toBe(10_000);
  });

  it('handles a partial refund', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1_000, {
          orderId: 'a',
          total: { amountMinor: 10_000, currency: GBP },
          status: 'partially_refunded',
          refundedAmount: { amountMinor: 2_500, currency: GBP },
        }),
      ],
      GBP,
    );
    expect(r.attributedRevenueNetOfRefunds.amountMinor).toBe(7_500);
    expect(r.statements.refunds).toContain('reversed in the ledger');
  });

  it('says so when nothing was refunded', () => {
    const r = summariseRevenue([attributed('code_redemption', 100)], GBP);
    expect(r.statements.refunds).toContain('No refunds');
  });
});

describe('derived figures', () => {
  it('computes revenue per unit of commission', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1_000, {
          orderId: 'a',
          total: { amountMinor: 10_000, currency: GBP },
        }),
      ],
      GBP,
    );
    expect(r.commissionOwed.amountMinor).toBe(1_000);
    expect(r.revenuePerCommissionUnit).toBe(10);
  });

  /** Null, never Infinity and never zero. */
  it('returns null rather than dividing by zero commission', () => {
    const r = summariseRevenue([attributed('code_redemption', 0)], GBP);
    expect(r.revenuePerCommissionUnit).toBeNull();
  });

  it('returns a null average order value when nothing was attributed', () => {
    const r = summariseRevenue([order(), order()], GBP);
    expect(r.averageOrderValue).toBeNull();
  });

  it('rounds the average order value half away from zero', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 1, { orderId: 'a', total: { amountMinor: 100, currency: GBP } }),
        attributed('code_redemption', 1, { orderId: 'b', total: { amountMinor: 101, currency: GBP } }),
        attributed('code_redemption', 1, { orderId: 'c', total: { amountMinor: 100, currency: GBP } }),
      ],
      GBP,
    );
    // 301 / 3 = 100.333… → 100
    expect(r.averageOrderValue?.amountMinor).toBe(100);
  });

  it('splits new from returning customers, with unknown as its own bucket', () => {
    const r = summariseRevenue(
      [
        attributed('code_redemption', 10, { orderId: 'a', customerType: 'new' }),
        attributed('code_redemption', 10, { orderId: 'b', customerType: 'returning' }),
        attributed('code_redemption', 10, { orderId: 'c', customerType: 'unknown' }),
      ],
      GBP,
    );
    expect(r.newCustomerOrders).toBe(1);
    expect(r.returningCustomerOrders).toBe(1);
    // Never folded into "returning": an export with no column is not evidence.
    expect(r.unknownCustomerTypeOrders).toBe(1);
  });
});

/**
 * The sentence that stops the section being overread. A brand should learn the
 * limit of attribution from the report, not from a sceptical analyst later.
 */
describe('the causation statement', () => {
  it('is present on every report, including an empty one', () => {
    for (const r of [summariseRevenue([], GBP), summariseRevenue([attributed('code_redemption', 1)], GBP)]) {
      expect(r.statements.causation).toContain('not a measurement of what caused');
      expect(r.statements.causation).toContain('would have bought anyway');
    }
  });
});

describe('empty and edge cases', () => {
  it('is safe with no orders at all', () => {
    const r = summariseRevenue([], GBP);
    expect(r.ordersSeen).toBe(0);
    expect(r.coverageBps).toBe(0);
    expect(r.attributedRevenue).toEqual({ amountMinor: 0, currency: GBP });
    expect(r.byMethod).toEqual([]);
    expect(r.averageOrderValue).toBeNull();
    expect(r.revenuePerCommissionUnit).toBeNull();
    expect(r.statements.coverage).toContain('nothing to attribute');
  });

  it('gives every method a zero share when attributed revenue is zero', () => {
    const r = summariseRevenue(
      [attributed('code_redemption', 0, { total: { amountMinor: 0, currency: GBP } })],
      GBP,
    );
    expect(r.byMethod[0]?.shareOfAttributedBps).toBe(0);
  });

  it('labels an order with no recorded reason rather than dropping it', () => {
    const r = summariseRevenue([order({ unattributedReason: null })], GBP);
    expect(r.unattributedReasons).toEqual([{ reason: 'no reason recorded', orders: 1 }]);
  });
});
