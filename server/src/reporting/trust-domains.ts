import type { Types } from 'mongoose';
import {
  breakdownByTrustDomain,
  type DomainBreakdown,
  type DomainCreatorInput,
  type DomainOrderInput,
} from '@anton/shared';
import { AttributionModel } from '../db/models/Attribution.js';
import { OrderModel } from '../db/models/Order.js';
import { CampaignCreatorModel, CreatorModel, PostModel } from '../db/models/index.js';

/**
 * Assembling the trust-domain breakdown for one campaign.
 *
 * The arithmetic, and the rule that suppresses a rate below the minimum
 * sample, live in shared/trust/domains.ts. This fetches three things and hands
 * them over: who took part and how they are tagged, how many people their
 * reportable posts reached, and which orders were credited to them.
 */
export async function buildTrustDomainSection(params: {
  campaignId: Types.ObjectId;
  brandId: Types.ObjectId;
  currency: string;
}): Promise<DomainBreakdown> {
  const joins = await CampaignCreatorModel.find({
    campaignId: params.campaignId,
    status: { $ne: 'declined' },
  })
    .select('creatorId')
    .lean();
  const creatorIds = joins.map((j) => j.creatorId);

  const [creators, posts, attributions] = await Promise.all([
    CreatorModel.find({ _id: { $in: creatorIds } }).select('_id trustDomains').lean(),
    /**
     * Reach from reportable posts only — the same rule the rest of the brand
     * report applies. A post still in review is not a smaller number; it is
     * an unestablished one, and it must not quietly enlarge a denominator.
     */
    PostModel.find({
      campaignId: params.campaignId,
      creatorId: { $in: creatorIds },
      $or: [
        { metricSource: { $ne: 'screenshot' } },
        { 'extraction.status': { $in: ['verified', 'auto_accepted'] } },
      ],
    })
      .select('creatorId metrics.reach')
      .lean(),
    AttributionModel.find({
      campaignId: params.campaignId,
      brandId: params.brandId,
      supersededBy: null,
    })
      .select('orderId creatorId')
      .lean(),
  ]);

  const reachByCreator = new Map<string, number>();
  for (const post of posts) {
    const reach = post.metrics?.reach;
    if (reach === null || reach === undefined) continue;
    const key = post.creatorId.toString();
    reachByCreator.set(key, (reachByCreator.get(key) ?? 0) + reach);
  }

  const domainsByCreator = new Map(creators.map((c) => [c._id.toString(), c.trustDomains ?? []]));

  const creatorInputs: DomainCreatorInput[] = creators.map((c) => ({
    creatorId: c._id.toString(),
    domains: c.trustDomains ?? [],
    // Null, not zero, when nothing was captured: zero reach would make any
    // order count look like an infinite conversion rate.
    reach: reachByCreator.get(c._id.toString()) ?? null,
  }));

  const orders = await OrderModel.find({ _id: { $in: attributions.map((a) => a.orderId) } })
    .select('_id total status')
    .lean();
  const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

  const orderInputs: DomainOrderInput[] = attributions.flatMap((a) => {
    const order = orderById.get(a.orderId.toString());
    // A cancelled order was never a sale, and a rolled-back one no longer exists.
    if (!order || order.status === 'cancelled') return [];
    return [
      {
        creatorId: a.creatorId.toString(),
        creatorDomains: domainsByCreator.get(a.creatorId.toString()) ?? [],
        revenue: order.total,
      },
    ];
  });

  return breakdownByTrustDomain(creatorInputs, orderInputs, params.currency);
}
