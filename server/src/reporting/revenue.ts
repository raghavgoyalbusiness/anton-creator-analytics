import { Types } from 'mongoose';
import {
  summariseRevenue,
  type AttributionMethod,
  type RevenueInput,
  type RevenueReport,
} from '@anton/shared';
import { AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel } from '../db/models/Commission.js';
import { OrderModel } from '../db/models/Order.js';
import { CreatorModel } from '../db/models/index.js';

/**
 * Assembling the revenue section of a brand report.
 *
 * The arithmetic lives in shared/, pure and testable. This module's only job is
 * to fetch the right rows and hand them over — and "the right rows" is the part
 * that can quietly mislead, so it is spelled out here.
 *
 * Orders are scoped to the brand AND to the campaign's own dates. A brand
 * running two campaigns must not see one campaign's report inflated by the
 * other's orders, and a report covering a window wider than the campaign it
 * describes is a claim nobody made.
 *
 * Attribution is scoped to the campaign as well. An order attributed to a
 * creator on a different campaign is somebody else's result.
 */

export interface RevenueSection extends RevenueReport {
  /** Per-creator, so the brand can see who actually drove the revenue. */
  readonly byCreator: readonly {
    readonly creatorId: string;
    readonly displayName: string | null;
    readonly handle: string | null;
    readonly orders: number;
    readonly revenue: { amountMinor: number; currency: string };
    readonly commission: { amountMinor: number; currency: string };
    readonly methods: readonly AttributionMethod[];
  }[];
  readonly window: { from: Date; to: Date };
}

export async function buildRevenueSection(params: {
  brandId: Types.ObjectId;
  campaignId: Types.ObjectId;
  from: Date;
  to: Date;
  currency: string;
}): Promise<RevenueSection> {
  /**
   * The window closes at the END of the last day.
   *
   * A campaign's endDate is a date, not an instant. Comparing an order's
   * timestamp against midnight silently drops every order placed on the final
   * day, which is often the biggest day of the campaign.
   */
  const queryTo = new Date(params.to);
  queryTo.setUTCHours(23, 59, 59, 999);

  /**
   * The window REPORTED is the campaign's own end date, not the instant used
   * to query. Rendering 23:59:59.999Z in a browser an hour ahead of UTC prints
   * the following day, so the report would claim a window a day wider than the
   * campaign it describes.
   */
  const to = params.to;

  const orders = await OrderModel.find({
    brandId: params.brandId,
    orderedAt: { $gte: params.from, $lte: queryTo },
  })
    .select('_id orderedAt total subtotal status refundedAmount customerType discountCodeUsed attributionRef')
    .lean();

  if (orders.length === 0) {
    return {
      ...summariseRevenue([], params.currency),
      byCreator: [],
      window: { from: params.from, to },
    };
  }

  const attributions = await AttributionModel.find({
    orderId: { $in: orders.map((o) => o._id) },
    campaignId: params.campaignId,
    supersededBy: null,
  }).lean();
  const attributionByOrder = new Map(attributions.map((a) => [a.orderId.toString(), a]));

  /**
   * Commission comes off the ledger, not recomputed from the rate.
   *
   * The ledger is what the creator is actually owed — it already carries any
   * adjustment and any reversal. Recomputing here would put a number in front
   * of the brand that disagrees with the one in front of the creator, and they
   * talk to each other.
   */
  const entries = await CommissionEntryModel.find({
    orderId: { $in: orders.map((o) => o._id) },
    campaignId: params.campaignId,
  }).lean();

  const commissionByOrder = new Map<string, number>();
  for (const e of entries) {
    const key = e.orderId?.toString() ?? '';
    commissionByOrder.set(key, (commissionByOrder.get(key) ?? 0) + e.amount.amountMinor);
  }

  /**
   * Why an order could not be matched, in words a brand can act on.
   *
   * Derived from the order's own signals rather than stored, because the
   * unattributed set is exactly the set with no attribution row to hang a
   * reason on.
   */
  const reasonFor = (order: (typeof orders)[number]): string => {
    if (order.status === 'cancelled') return 'the order was cancelled';
    if (order.discountCodeUsed) {
      return 'the order used a discount code that is not one of the creator codes we issued';
    }
    if (order.attributionRef) return 'the link on the order is not one we issued';
    return 'no creator code or link on the order';
  };

  const inputs: RevenueInput[] = orders.map((order) => {
    const attribution = attributionByOrder.get(order._id.toString());
    return {
      orderId: order._id.toString(),
      orderedAt: order.orderedAt,
      total: order.total,
      subtotal: order.subtotal,
      status: order.status,
      refundedAmount: order.refundedAmount ?? null,
      customerType: order.customerType,
      attribution: attribution
        ? {
            creatorId: attribution.creatorId.toString(),
            method: attribution.method as AttributionMethod,
            confidence: attribution.confidence as 'direct' | 'inferred',
            commission: {
              amountMinor: commissionByOrder.get(order._id.toString()) ?? 0,
              currency: order.total.currency,
            },
          }
        : null,
      unattributedReason: attribution ? null : reasonFor(order),
    };
  });

  const report = summariseRevenue(inputs, params.currency);

  /* ---- per creator */

  type Bucket = {
    orders: number;
    revenue: number;
    commission: number;
    methods: Set<AttributionMethod>;
  };
  const buckets = new Map<string, Bucket>();

  for (const input of inputs) {
    if (!input.attribution) continue;
    const key = input.attribution.creatorId;
    const bucket = buckets.get(key) ?? { orders: 0, revenue: 0, commission: 0, methods: new Set() };
    bucket.orders += 1;
    bucket.revenue += input.total.amountMinor;
    bucket.commission += input.attribution.commission.amountMinor;
    bucket.methods.add(input.attribution.method);
    buckets.set(key, bucket);
  }

  const creators = await CreatorModel.find({ _id: { $in: [...buckets.keys()] } })
    .select('displayName handles')
    .lean();
  const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));

  const byCreator = [...buckets.entries()]
    .map(([creatorId, bucket]) => {
      const creator = creatorById.get(creatorId);
      return {
        creatorId,
        displayName: creator?.displayName ?? null,
        handle: creator?.handles[0]?.handle ?? null,
        orders: bucket.orders,
        revenue: { amountMinor: bucket.revenue, currency: params.currency },
        commission: { amountMinor: bucket.commission, currency: params.currency },
        methods: [...bucket.methods],
      };
    })
    .sort((a, b) => b.revenue.amountMinor - a.revenue.amountMinor);

  return { ...report, byCreator, window: { from: params.from, to } };
}
