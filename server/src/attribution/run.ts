import { Types } from 'mongoose';
import {
  attributeOrder,
  clampWindowHours,
  confidenceFor,
  selectBasis,
  summariseDecisions,
  type AttributionDecision,
  type AttributionSummary,
  type CandidateAsset,
} from '@anton/shared';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { OrderModel } from '../db/models/Order.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { CampaignCreatorModel, CampaignModel } from '../db/models/index.js';
import { ApiError } from '../lib/errors.js';

/**
 * Running attribution over a brand's orders.
 *
 * Idempotent by construction: an order that already carries a live attribution
 * is left alone unless the decision genuinely changed, and a changed decision
 * supersedes rather than edits. Re-running over the same orders therefore
 * produces the same rows and the same balances, which is the only way a number
 * shown to a brand last week can still be defended this week.
 */

export interface RunResult extends AttributionSummary {
  readonly created: number;
  readonly superseded: number;
  readonly unchanged: number;
  readonly conflictsLogged: number;
  readonly ordersConsidered: number;
}

interface LoadedOrder {
  _id: Types.ObjectId;
  externalOrderId: string;
  orderedAt: Date;
  total: { amountMinor: number; currency: string };
  subtotal: { amountMinor: number; currency: string };
  discountCodeKey?: string | null;
  attributionRef?: string | null;
  status: string;
}

function toCandidate(a: {
  _id: Types.ObjectId;
  campaignCreatorId: Types.ObjectId;
  campaignId: Types.ObjectId;
  creatorId: Types.ObjectId;
  type: string;
  commissionRateBps: number;
  commissionRateBasis: string;
  activeFrom: Date;
  activeUntil?: Date | null;
  revokedAt?: Date | null;
  status: string;
}): CandidateAsset {
  return {
    trackingAssetId: a._id.toString(),
    campaignCreatorId: a.campaignCreatorId.toString(),
    campaignId: a.campaignId.toString(),
    creatorId: a.creatorId.toString(),
    type: a.type as CandidateAsset['type'],
    commissionRateBps: a.commissionRateBps,
    commissionRateBasis: a.commissionRateBasis as CandidateAsset['commissionRateBasis'],
    activeFrom: a.activeFrom,
    activeUntil: a.activeUntil ?? null,
    revokedAt: a.revokedAt ?? null,
    status: a.status,
  };
}

/**
 * The window for a campaign, clamped.
 *
 * Read per campaign rather than per brand because campaigns run to different
 * rhythms — a launch week and an always-on affiliate programme should not be
 * forced to share a number.
 */
async function windowsByCampaign(brandId: Types.ObjectId): Promise<Map<string, number>> {
  const campaigns = await CampaignModel.find({ brandId })
    .select('_id attributionWindowHours')
    .lean();
  const map = new Map<string, number>();
  for (const c of campaigns) {
    map.set(c._id.toString(), clampWindowHours(c.attributionWindowHours ?? null));
  }
  return map;
}

export interface RunOptions {
  readonly brandId: Types.ObjectId;
  /** Restrict to specific orders — used after an ingest to touch only what moved. */
  readonly orderIds?: readonly Types.ObjectId[];
  /** Restrict by external id, which is what an ingest result hands back. */
  readonly externalOrderIds?: readonly string[];
  readonly limit?: number;
}

export async function runAttribution(options: RunOptions): Promise<RunResult> {
  const filter: Record<string, unknown> = { brandId: options.brandId };
  if (options.orderIds) filter._id = { $in: options.orderIds };
  if (options.externalOrderIds) filter.externalOrderId = { $in: options.externalOrderIds };

  const orders = (await OrderModel.find(filter)
    .sort({ orderedAt: 1 })
    .limit(options.limit ?? 20_000)
    .lean()) as unknown as LoadedOrder[];

  if (orders.length === 0) {
    return {
      ...summariseDecisions([]),
      created: 0,
      superseded: 0,
      unchanged: 0,
      conflictsLogged: 0,
      ordersConsidered: 0,
    };
  }

  /**
   * Candidates are loaded once for the whole run, not per order.
   *
   * A brand has tens of assets and can have tens of thousands of orders; a
   * query per order turns a routine re-run into an outage.
   */
  const [assets, windows] = await Promise.all([
    TrackingAssetModel.find({ brandId: options.brandId }).lean(),
    windowsByCampaign(options.brandId),
  ]);

  const byMatchKey = new Map<string, CandidateAsset[]>();
  const byShortCode = new Map<string, CandidateAsset[]>();
  for (const a of assets) {
    const candidate = toCandidate(a);
    if (a.type === 'discount_code') {
      const list = byMatchKey.get(a.matchKey) ?? [];
      list.push(candidate);
      byMatchKey.set(a.matchKey, list);
    } else if (a.shortCode) {
      const list = byShortCode.get(a.shortCode.toUpperCase()) ?? [];
      list.push(candidate);
      byShortCode.set(a.shortCode.toUpperCase(), list);
    }
  }

  const existing = await AttributionModel.find({
    orderId: { $in: orders.map((o) => o._id) },
    supersededBy: null,
  }).lean();
  const liveByOrder = new Map(existing.map((a) => [a.orderId.toString(), a]));

  const decisions: AttributionDecision[] = [];
  let created = 0;
  let superseded = 0;
  let unchanged = 0;
  let conflictsLogged = 0;

  for (const order of orders) {
    const codeMatches = order.discountCodeKey ? (byMatchKey.get(order.discountCodeKey) ?? []) : [];
    const refMatches = order.attributionRef
      ? (byShortCode.get(order.attributionRef.toUpperCase()) ?? [])
      : [];

    /**
     * The window comes from the campaign the winning asset belongs to, which
     * is not known until a winner is picked. Resolved in two passes: decide
     * with the widest window any candidate's campaign allows, then re-decide
     * with that campaign's own window if it turns out to be narrower.
     */
    const candidateWindows = [...codeMatches, ...refMatches].map(
      (c) => windows.get(c.campaignId) ?? clampWindowHours(null),
    );
    const widest = candidateWindows.length > 0 ? Math.max(...candidateWindows) : clampWindowHours(null);

    const attributionOrder = {
      orderId: order._id.toString(),
      orderedAt: order.orderedAt,
      discountCodeKey: order.discountCodeKey ?? null,
      attributionRef: order.attributionRef ?? null,
      status: order.status,
    };

    let decision = attributeOrder({
      order: attributionOrder,
      codeMatches,
      refMatches,
      windowHours: widest,
    });

    if (decision.attributed && decision.asset) {
      const own = windows.get(decision.asset.campaignId) ?? clampWindowHours(null);
      if (own !== widest) {
        decision = attributeOrder({
          order: attributionOrder,
          codeMatches,
          refMatches,
          windowHours: own,
        });
      }
    }

    decisions.push(decision);

    const live = liveByOrder.get(order._id.toString());

    /**
     * A manual assignment is an operator's judgement about a specific order.
     * A scheduled re-run must never quietly overrule it.
     */
    if (live && live.method === 'manual_assignment') {
      unchanged += 1;
      continue;
    }

    if (!decision.attributed || !decision.asset) {
      if (live) {
        await AttributionModel.updateOne(
          { _id: live._id, supersededBy: null },
          {
            $set: {
              supersededAt: new Date(),
              supersededBy: live._id,
              supersededReason: decision.note ?? 'no longer attributable',
            },
          },
        );
        superseded += 1;
      }
      continue;
    }

    const asset = decision.asset;
    const basis = selectBasis(
      { subtotal: order.subtotal, total: order.total },
      asset.commissionRateBasis,
    );

    const sameAsLive =
      live !== undefined &&
      live.campaignCreatorId.toString() === asset.campaignCreatorId &&
      live.method === decision.method &&
      live.rateAppliedBps === asset.commissionRateBps &&
      live.rateBasis === asset.commissionRateBasis &&
      live.basisAmount.amountMinor === basis.amountMinor &&
      live.windowHoursUsed === decision.windowHoursUsed;

    if (sameAsLive) {
      unchanged += 1;
    } else {
      /**
       * The id is minted before either write, so the old row can be retired
       * BEFORE the new one is inserted.
       *
       * Order matters: the unique index allows exactly one live attribution per
       * order, so creating first and superseding second leaves an instant where
       * two rows are live and the insert is rejected. Retiring first also means
       * a crash between the two writes leaves the order unattributed rather
       * than credited twice.
       */
      const newId = new Types.ObjectId();

      if (live) {
        const retired = await AttributionModel.updateOne(
          { _id: live._id, supersededBy: null },
          {
            $set: {
              supersededAt: new Date(),
              supersededBy: newId,
              supersededReason: 'a re-run produced a different decision',
            },
          },
        );
        // Someone else retired it first. Leave their decision alone rather
        // than racing them for the one live slot.
        if (retired.modifiedCount === 0) {
          unchanged += 1;
          continue;
        }
        superseded += 1;
      }

      await AttributionModel.create({
        _id: newId,
        orderId: order._id,
        brandId: options.brandId,
        campaignId: new Types.ObjectId(asset.campaignId),
        campaignCreatorId: new Types.ObjectId(asset.campaignCreatorId),
        creatorId: new Types.ObjectId(asset.creatorId),
        method: decision.method,
        confidence: decision.confidence,
        attributedAt: new Date(),
        attributedValue: order.total,
        windowHoursUsed: decision.windowHoursUsed,
        rateAppliedBps: asset.commissionRateBps,
        rateBasis: asset.commissionRateBasis,
        basisAmount: basis,
        trackingAssetId: new Types.ObjectId(asset.trackingAssetId),
        note: decision.note,
      });
      created += 1;
    }

    if (decision.conflict) {
      const res = await AttributionConflictModel.updateOne(
        { orderId: order._id },
        {
          $setOnInsert: {
            orderId: order._id,
            brandId: options.brandId,
            winningMethod: decision.method,
            winningCampaignCreatorId: new Types.ObjectId(asset.campaignCreatorId),
            losingMethod: decision.conflict.losingMethod,
            losingCampaignCreatorId: new Types.ObjectId(decision.conflict.losingCampaignCreatorId),
            losingTrackingAssetId: new Types.ObjectId(decision.conflict.losingTrackingAssetId),
            detectedAt: new Date(),
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount > 0) conflictsLogged += 1;
    }
  }

  return {
    ...summariseDecisions(decisions),
    created,
    superseded,
    unchanged,
    conflictsLogged,
    ordersConsidered: orders.length,
  };
}

/* ------------------------------------------------------- manual override */

/**
 * Assigning an order to a creator by hand.
 *
 * Supersedes whatever was there rather than editing it, and records who did it
 * and why. An unexplained manual reassignment is indistinguishable from a
 * mistake six months later, so the reason is required at the schema.
 */
export async function assignManually(params: {
  brandId: Types.ObjectId;
  orderId: Types.ObjectId;
  campaignCreatorId: Types.ObjectId;
  operatorId: Types.ObjectId;
  reason: string;
}): Promise<{ attributionId: string; supersededId: string | null }> {
  const order = await OrderModel.findOne({
    _id: params.orderId,
    brandId: params.brandId,
  }).lean();
  if (!order) throw ApiError.notFound('order_not_found', 'No such order for this brand.');

  /**
   * The join is loaded through its campaign so the brand can be checked. An
   * operator must not be able to assign brand A's order to a creator working
   * for brand B by passing an id from another tenant.
   */
  const join = await CampaignCreatorModel.findById(params.campaignCreatorId).lean();
  if (!join) throw ApiError.notFound('join_not_found', 'No such campaign participation.');

  const campaign = await CampaignModel.findById(join.campaignId).select('brandId').lean();
  if (!campaign || campaign.brandId.toString() !== params.brandId.toString()) {
    throw ApiError.notFound('join_not_found', 'No such campaign participation for this brand.');
  }

  /**
   * The rate comes from the creator's own asset on that campaign where one
   * exists. A manual assignment should not invent commission terms nobody
   * agreed to, and falling back to zero makes the absence visible rather than
   * paying an arbitrary number.
   */
  const asset = await TrackingAssetModel.findOne({
    campaignCreatorId: params.campaignCreatorId,
  })
    .sort({ activeFrom: -1 })
    .lean();

  const rateBps = asset?.commissionRateBps ?? 0;
  const rateBasis = asset?.commissionRateBasis ?? 'order_subtotal';
  const basis = selectBasis(
    { subtotal: order.subtotal, total: order.total },
    rateBasis as 'order_subtotal' | 'order_total',
  );

  const live = await AttributionModel.findOne({
    orderId: params.orderId,
    supersededBy: null,
  }).lean();

  // Retire first, then insert — same reason as in runAttribution: only one
  // attribution per order may be live, so the two writes cannot be the other
  // way round.
  const newId = new Types.ObjectId();

  if (live) {
    const retired = await AttributionModel.updateOne(
      { _id: live._id, supersededBy: null },
      {
        $set: {
          supersededAt: new Date(),
          supersededBy: newId,
          supersededReason: `assigned by hand: ${params.reason}`,
        },
      },
    );
    if (retired.modifiedCount === 0) {
      throw ApiError.conflict(
        'attribution_moved',
        'This order was reassigned by someone else while you were looking at it. Reload and try again.',
      );
    }
  }

  await AttributionModel.create({
    _id: newId,
    orderId: params.orderId,
    brandId: params.brandId,
    campaignId: join.campaignId,
    campaignCreatorId: params.campaignCreatorId,
    creatorId: join.creatorId,
    method: 'manual_assignment',
    confidence: confidenceFor('manual_assignment'),
    attributedAt: new Date(),
    attributedValue: order.total,
    windowHoursUsed: null,
    rateAppliedBps: rateBps,
    rateBasis,
    basisAmount: basis,
    trackingAssetId: asset?._id ?? null,
    assignedByOperatorId: params.operatorId,
    note: params.reason,
  });

  return { attributionId: newId.toString(), supersededId: live?._id.toString() ?? null };
}

/**
 * Removes an attribution without putting another in its place.
 *
 * The row is superseded by itself, which is how "this was withdrawn" is
 * distinguished from "this was replaced" when reading the chain back.
 */
export async function withdrawAttribution(params: {
  brandId: Types.ObjectId;
  orderId: Types.ObjectId;
  operatorId: Types.ObjectId;
  reason: string;
}): Promise<{ withdrew: boolean }> {
  const live = await AttributionModel.findOne({
    orderId: params.orderId,
    brandId: params.brandId,
    supersededBy: null,
  });
  if (!live) return { withdrew: false };

  await AttributionModel.updateOne(
    { _id: live._id, supersededBy: null },
    {
      $set: {
        supersededBy: live._id,
        supersededAt: new Date(),
        supersededReason: `withdrawn by an operator: ${params.reason}`,
      },
    },
  );
  return { withdrew: true };
}
