import type { Money } from '../types/common.js';
import type { AttributionMethod } from '../types/commerce.js';
import { roundHalfAwayFromZero } from '../money/currency.js';

/**
 * The revenue section of a brand report.
 *
 * The commercial argument Anton exists to make is that a hundred micro
 * creators beat one mega creator on cost per engaged reach. Revenue is the
 * strongest version of that argument and therefore the most tempting place to
 * flatter the numbers, so this module is built the other way round:
 *
 * The attribution method breakdown is not optional and not a drill-down. It is
 * returned on every report, always, because "£41,000 attributed" means
 * something entirely different when it is code redemptions than when it is
 * last-touch link clicks — and a brand that discovers that distinction later
 * feels misled, correctly.
 *
 * Unattributed orders are reported beside attributed ones with the same
 * prominence. A programme that can account for 58% of a brand's orders is a
 * useful programme honestly described; one that quietly reports only the 58%
 * is a lie by omission.
 *
 * Pure. Every input is passed in, so a figure in front of a brand can be
 * reproduced from a fixture and argued with.
 */

export interface RevenueInput {
  readonly orderId: string;
  readonly orderedAt: Date;
  readonly total: Money;
  readonly subtotal: Money;
  readonly status: string;
  readonly refundedAmount: Money | null;
  readonly customerType: string;
  /** Null when nothing claimed this order. */
  readonly attribution: {
    readonly creatorId: string;
    readonly method: AttributionMethod;
    readonly confidence: 'direct' | 'inferred';
    readonly commission: Money;
  } | null;
  /** Present when the order has no attribution, so the gap is explicable. */
  readonly unattributedReason: string | null;
}

export interface MethodShare {
  readonly method: AttributionMethod;
  readonly label: string;
  readonly confidence: 'direct' | 'inferred';
  readonly orders: number;
  readonly revenue: Money;
  /** Share of ATTRIBUTED revenue, in basis points. Never of total revenue. */
  readonly shareOfAttributedBps: number;
  readonly explanation: string;
}

export interface RevenueReport {
  readonly currency: string;
  /** Every order in the window, attributed or not. */
  readonly ordersSeen: number;
  readonly ordersAttributed: number;
  readonly ordersUnattributed: number;
  /** Attributed share of orders, in basis points. */
  readonly coverageBps: number;

  readonly attributedRevenue: Money;
  readonly attributedRevenueNetOfRefunds: Money;
  readonly unattributedRevenue: Money;
  readonly totalRevenueSeen: Money;

  readonly refundedOrders: number;
  readonly refundedValue: Money;

  readonly commissionOwed: Money;
  /** Revenue per unit of commission. Null when no commission was earned. */
  readonly revenuePerCommissionUnit: number | null;
  /** Average attributed order value. Null when nothing was attributed. */
  readonly averageOrderValue: Money | null;

  readonly newCustomerOrders: number;
  readonly returningCustomerOrders: number;
  readonly unknownCustomerTypeOrders: number;

  /** Always present, always rendered. See the note at the top of this file. */
  readonly byMethod: readonly MethodShare[];
  readonly unattributedReasons: readonly { reason: string; orders: number }[];

  /**
   * The sentences the report must carry. Server-side so a redesign of the
   * front end cannot drop them, and phrased so they cannot be read as a claim
   * Anton has not earned.
   */
  readonly statements: {
    readonly coverage: string;
    readonly method: string;
    readonly refunds: string;
    readonly causation: string;
  };
}

const METHOD_META: Record<
  AttributionMethod,
  { label: string; confidence: 'direct' | 'inferred'; explanation: string }
> = {
  code_redemption: {
    label: 'Discount code used',
    confidence: 'direct',
    explanation:
      'The customer typed this creator’s code into your checkout. This is the strongest signal available without a platform integration.',
  },
  link_last_touch: {
    label: 'Arrived through a tracked link',
    confidence: 'inferred',
    explanation:
      'Your store recorded that the session arrived through this creator’s link. That is a correlation, not proof the creator caused the sale — the customer may have been going to buy anyway.',
  },
  manual_assignment: {
    label: 'Assigned by hand',
    confidence: 'direct',
    explanation:
      'Someone at Anton assigned this order to a creator after looking at it, and recorded why. The reason is on the record.',
  },
};

function zero(currency: string): Money {
  return { amountMinor: 0, currency };
}

function add(a: Money, b: Money): Money {
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

/**
 * Which figure counts as the order's revenue.
 *
 * The total, not the subtotal: a brand thinks of revenue as what the customer
 * paid. The subtotal is the commission basis and is reported separately, so the
 * two are never confused for each other.
 */
function revenueOf(order: RevenueInput): Money {
  return order.total;
}

export function summariseRevenue(
  orders: readonly RevenueInput[],
  currency: string,
): RevenueReport {
  let attributedRevenue = zero(currency);
  let unattributedRevenue = zero(currency);
  let refundedValue = zero(currency);
  let commissionOwed = zero(currency);
  let refundedOrders = 0;
  let ordersAttributed = 0;
  let newCustomerOrders = 0;
  let returningCustomerOrders = 0;
  let unknownCustomerTypeOrders = 0;

  const byMethod = new Map<AttributionMethod, { orders: number; revenue: number }>();
  const reasons = new Map<string, number>();

  for (const order of orders) {
    const revenue = revenueOf(order);

    if (order.customerType === 'new') newCustomerOrders += 1;
    else if (order.customerType === 'returning') returningCustomerOrders += 1;
    else unknownCustomerTypeOrders += 1;

    if (order.refundedAmount && order.refundedAmount.amountMinor > 0) {
      refundedOrders += 1;
      refundedValue = add(refundedValue, order.refundedAmount);
    }

    if (order.attribution) {
      ordersAttributed += 1;
      attributedRevenue = add(attributedRevenue, revenue);
      commissionOwed = add(commissionOwed, order.attribution.commission);

      const bucket = byMethod.get(order.attribution.method) ?? { orders: 0, revenue: 0 };
      bucket.orders += 1;
      bucket.revenue += revenue.amountMinor;
      byMethod.set(order.attribution.method, bucket);
    } else {
      unattributedRevenue = add(unattributedRevenue, revenue);
      const reason = order.unattributedReason ?? 'no reason recorded';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  const totalRevenueSeen = add(attributedRevenue, unattributedRevenue);
  const ordersUnattributed = orders.length - ordersAttributed;

  /**
   * Refunds come off the attributed figure, not off the headline.
   *
   * A brand comparing this to their own dashboard needs gross attributed
   * revenue to reconcile; they also need to know what came back. Both are
   * given, and neither is silently substituted for the other.
   */
  const attributedRefunds = orders
    .filter((o) => o.attribution !== null && o.refundedAmount !== null)
    .reduce((n, o) => n + (o.refundedAmount?.amountMinor ?? 0), 0);
  const attributedRevenueNetOfRefunds: Money = {
    amountMinor: attributedRevenue.amountMinor - attributedRefunds,
    currency,
  };

  const methodShares: MethodShare[] = [...byMethod.entries()]
    .map(([method, bucket]) => ({
      method,
      label: METHOD_META[method].label,
      confidence: METHOD_META[method].confidence,
      orders: bucket.orders,
      revenue: { amountMinor: bucket.revenue, currency },
      // Of attributed revenue, never of total. A share of a number that
      // includes orders nobody claimed would be meaningless.
      shareOfAttributedBps:
        attributedRevenue.amountMinor > 0
          ? roundHalfAwayFromZero((bucket.revenue / attributedRevenue.amountMinor) * 10_000)
          : 0,
      explanation: METHOD_META[method].explanation,
    }))
    .sort((a, b) => b.revenue.amountMinor - a.revenue.amountMinor);

  const coverageBps =
    orders.length > 0 ? roundHalfAwayFromZero((ordersAttributed / orders.length) * 10_000) : 0;

  const inferredShare = methodShares
    .filter((m) => m.confidence === 'inferred')
    .reduce((n, m) => n + m.shareOfAttributedBps, 0);

  return {
    currency,
    ordersSeen: orders.length,
    ordersAttributed,
    ordersUnattributed,
    coverageBps,
    attributedRevenue,
    attributedRevenueNetOfRefunds,
    unattributedRevenue,
    totalRevenueSeen,
    refundedOrders,
    refundedValue,
    commissionOwed,
    revenuePerCommissionUnit:
      commissionOwed.amountMinor > 0
        ? attributedRevenue.amountMinor / commissionOwed.amountMinor
        : null,
    averageOrderValue:
      ordersAttributed > 0
        ? {
            amountMinor: roundHalfAwayFromZero(attributedRevenue.amountMinor / ordersAttributed),
            currency,
          }
        : null,
    newCustomerOrders,
    returningCustomerOrders,
    unknownCustomerTypeOrders,
    byMethod: methodShares,
    unattributedReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, orders: count }))
      .sort((a, b) => b.orders - a.orders),
    statements: {
      coverage:
        orders.length === 0
          ? 'No orders have been supplied for this campaign yet, so there is nothing to attribute.'
          : `Anton matched ${ordersAttributed} of ${orders.length} orders to a creator. The remaining ${ordersUnattributed} carried no code or link we issued and are shown here rather than left out, because a programme that can account for some of your orders is not the same as one that caused all of them.`,
      method:
        methodShares.length === 0
          ? 'Nothing was attributed, so there is no method breakdown.'
          : inferredShare > 0
            ? `${(inferredShare / 100).toFixed(1)}% of attributed revenue rests on a tracked link rather than a code. A link tells you the customer arrived through a creator; a code tells you they acted on one. Both are shown separately for that reason.`
            : 'Every attributed order here was matched by a discount code the customer typed at checkout, which is the strongest signal available without a platform integration.',
      refunds:
        refundedOrders === 0
          ? 'No refunds have been reported against these orders.'
          : `${refundedOrders} attributed or unattributed orders were refunded. Commission on a refunded order is reversed in the ledger, so what a creator is owed already reflects it.`,
      /**
       * The sentence that stops the whole section being overread. Attribution
       * says an order carried a creator's code; it does not say the creator
       * caused the purchase. A brand should get that from the report, not from
       * a sceptical analyst three months later.
       */
      causation:
        'Attribution records which creator an order can be traced to. It is not a measurement of what caused the purchase: some of these customers would have bought anyway, and some orders Anton could not match were caused by a creator whose code the customer did not use.',
    },
  };
}

/** Basis points rendered as a percentage string, for a report surface. */
export function bpsAsPercent(bps: number, decimals = 1): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}
