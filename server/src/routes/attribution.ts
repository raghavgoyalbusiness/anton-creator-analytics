import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { formatMoney, objectIdSchema } from '@anton/shared';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { OrderModel } from '../db/models/Order.js';
import { BrandModel, CampaignCreatorModel, CreatorModel } from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { assignManually, runAttribution, withdrawAttribution } from '../attribution/run.js';

export const attributionRouter: Router = Router();
attributionRouter.use(requireOperator);

/**
 * Attribution.
 *
 * Every route is scoped by a brand id taken from the path. Attribution decides
 * who gets paid, so a query that could reach across brands is not a privacy
 * bug here — it is a payment going to the wrong person.
 */

async function requireBrand(brandIdRaw: unknown): Promise<Types.ObjectId> {
  if (typeof brandIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(brandIdRaw)) {
    throw ApiError.badRequest('bad_brand_id', 'Not a valid brand id.');
  }
  const brand = await BrandModel.findById(brandIdRaw).select('_id').lean();
  if (!brand) throw ApiError.notFound('brand_not_found', 'No such brand.');
  return brand._id;
}

function requireObjectId(raw: unknown, what: string): Types.ObjectId {
  if (typeof raw !== 'string' || !/^[a-f0-9]{24}$/i.test(raw)) {
    throw ApiError.badRequest('bad_id', `Not a valid ${what} id.`);
  }
  return new Types.ObjectId(raw);
}

/* ------------------------------------------------------------------ run */

attributionRouter.post(
  '/brands/:brandId/attribution/run',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    // A full run is a scan over every order the brand has. It is cheap enough
    // to do after an upload and expensive enough not to leave uncapped.
    await enforceRateLimit(
      { bucket: 'attribution_run', subject: brandId.toString(), limit: 60, windowMs: HOUR_MS },
      'Attribution has been re-run too many times for this brand in the last hour.',
    );

    const result = await runAttribution({ brandId });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.attributionRun,
      subjectKind: 'Brand',
      subjectId: brandId,
      detail: {
        brandId: brandId.toString(),
        considered: result.ordersConsidered,
        attributed: result.attributed,
        unattributed: result.unattributed,
        created: result.created,
        superseded: result.superseded,
        conflicts: result.conflictsLogged,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(result);
  }),
);

/* -------------------------------------------------------------- listing */

const listQuerySchema = z.object({
  campaignId: objectIdSchema.optional(),
  creatorId: objectIdSchema.optional(),
  method: z.enum(['code_redemption', 'link_last_touch', 'manual_assignment', 'all']).default('all'),
  /** Superseded rows are hidden by default: they are history, not the answer. */
  includeSuperseded: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

attributionRouter.get(
  '/brands/:brandId/attributions',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const query = parseQuery(listQuerySchema, req);

    const filter: Record<string, unknown> = { brandId };
    if (!query.includeSuperseded) filter.supersededBy = null;
    if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);
    if (query.creatorId) filter.creatorId = new Types.ObjectId(query.creatorId);
    if (query.method !== 'all') filter.method = query.method;

    const rows = await AttributionModel.find(filter)
      .sort({ attributedAt: -1 })
      .limit(query.limit)
      .lean();

    const [orders, creators] = await Promise.all([
      OrderModel.find({ _id: { $in: rows.map((r) => r.orderId) } })
        .select('externalOrderId orderedAt total status discountCodeUsed attributionRef')
        .lean(),
      CreatorModel.find({ _id: { $in: rows.map((r) => r.creatorId) } })
        .select('displayName handles')
        .lean(),
    ]);
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));

    res.json({
      attributions: rows.map((r) => {
        const order = orderById.get(r.orderId.toString());
        const creator = creatorById.get(r.creatorId.toString());
        return {
          id: r._id.toString(),
          orderId: r.orderId.toString(),
          externalOrderId: order?.externalOrderId ?? null,
          orderedAt: order?.orderedAt ?? null,
          orderStatus: order?.status ?? null,
          orderTotal: order?.total ?? null,
          discountCodeUsed: order?.discountCodeUsed ?? null,
          creatorId: r.creatorId.toString(),
          creatorName: creator?.displayName ?? null,
          campaignId: r.campaignId.toString(),
          campaignCreatorId: r.campaignCreatorId.toString(),
          method: r.method,
          confidence: r.confidence,
          attributedAt: r.attributedAt,
          attributedValue: r.attributedValue,
          windowHoursUsed: r.windowHoursUsed,
          rateAppliedBps: r.rateAppliedBps,
          rateBasis: r.rateBasis,
          basisAmount: r.basisAmount,
          supersededBy: r.supersededBy?.toString() ?? null,
          supersededAt: r.supersededAt ?? null,
          supersededReason: r.supersededReason ?? null,
          note: r.note ?? null,
        };
      }),
    });
  }),
);

/**
 * Orders with no live attribution.
 *
 * A first-class view, not a leftover. The size of this list is the honest
 * measure of how much of a brand's revenue the programme can actually account
 * for, and hiding it would make every attributed figure look better than it is.
 */
attributionRouter.get(
  '/brands/:brandId/attribution/unattributed',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);

    const attributedIds = await AttributionModel.find({ brandId, supersededBy: null })
      .select('orderId')
      .lean();

    const orders = await OrderModel.find({
      brandId,
      _id: { $nin: attributedIds.map((a) => a.orderId) },
    })
      .sort({ orderedAt: -1 })
      .limit(limit)
      .lean();

    const totalOrders = await OrderModel.countDocuments({ brandId });

    res.json({
      counts: {
        orders: totalOrders,
        attributed: attributedIds.length,
        unattributed: totalOrders - attributedIds.length,
      },
      orders: orders.map((o) => ({
        id: o._id.toString(),
        externalOrderId: o.externalOrderId,
        orderedAt: o.orderedAt,
        total: o.total,
        status: o.status,
        // The signal that WAS present, so the reason is arguable.
        discountCodeUsed: o.discountCodeUsed ?? null,
        attributionRef: o.attributionRef ?? null,
      })),
    });
  }),
);

/* ------------------------------------------------------------ conflicts */

attributionRouter.get(
  '/brands/:brandId/attribution/conflicts',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const unreviewedOnly = req.query.reviewed !== 'all';

    const filter: Record<string, unknown> = { brandId };
    if (unreviewedOnly) filter.reviewedAt = null;

    const conflicts = await AttributionConflictModel.find(filter)
      .sort({ detectedAt: -1 })
      .limit(200)
      .lean();

    const joinIds = conflicts.flatMap((c) => [c.winningCampaignCreatorId, c.losingCampaignCreatorId]);
    const joins = await CampaignCreatorModel.find({ _id: { $in: joinIds } })
      .select('creatorId campaignId')
      .lean();
    const creators = await CreatorModel.find({ _id: { $in: joins.map((j) => j.creatorId) } })
      .select('displayName')
      .lean();

    const nameForJoin = new Map(
      joins.map((j) => [
        j._id.toString(),
        creators.find((c) => c._id.toString() === j.creatorId.toString())?.displayName ?? null,
      ]),
    );

    const orders = await OrderModel.find({ _id: { $in: conflicts.map((c) => c.orderId) } })
      .select('externalOrderId orderedAt total')
      .lean();
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    res.json({
      conflicts: conflicts.map((c) => {
        const order = orderById.get(c.orderId.toString());
        return {
          id: c._id.toString(),
          orderId: c.orderId.toString(),
          externalOrderId: order?.externalOrderId ?? null,
          orderedAt: order?.orderedAt ?? null,
          orderTotal: order?.total ?? null,
          orderTotalFormatted: order ? formatMoney(order.total) : null,
          winningMethod: c.winningMethod,
          winningCampaignCreatorId: c.winningCampaignCreatorId.toString(),
          winningCreatorName: nameForJoin.get(c.winningCampaignCreatorId.toString()) ?? null,
          losingMethod: c.losingMethod,
          losingCampaignCreatorId: c.losingCampaignCreatorId.toString(),
          losingCreatorName: nameForJoin.get(c.losingCampaignCreatorId.toString()) ?? null,
          detectedAt: c.detectedAt,
          reviewedAt: c.reviewedAt,
          resolution: c.resolution,
        };
      }),
    });
  }),
);

const reviewSchema = z.object({
  resolution: z.string().min(1, 'say what you decided').max(500),
});

attributionRouter.post(
  '/brands/:brandId/attribution/conflicts/:conflictId/review',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const conflictId = requireObjectId(req.params.conflictId, 'conflict');
    const body = parseBody(reviewSchema, req);
    const { operator } = getOperator(req);

    const updated = await AttributionConflictModel.findOneAndUpdate(
      { _id: conflictId, brandId },
      {
        $set: {
          reviewedAt: new Date(),
          reviewedByOperatorId: operator._id,
          resolution: body.resolution,
        },
      },
      { new: true },
    ).lean();
    if (!updated) throw ApiError.notFound('conflict_not_found', 'No such conflict for this brand.');

    res.json({ ok: true, reviewedAt: updated.reviewedAt });
  }),
);

/* -------------------------------------------------------- manual override */

const assignSchema = z.object({
  campaignCreatorId: objectIdSchema,
  reason: z.string().min(1, 'say why this was assigned by hand').max(500),
});

attributionRouter.post(
  '/brands/:brandId/orders/:orderId/attribution',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const orderId = requireObjectId(req.params.orderId, 'order');
    const body = parseBody(assignSchema, req);
    const { operator } = getOperator(req);

    const result = await assignManually({
      brandId,
      orderId,
      campaignCreatorId: new Types.ObjectId(body.campaignCreatorId),
      operatorId: operator._id,
      reason: body.reason,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.attributionAssigned,
      subjectKind: 'Attribution',
      subjectId: new Types.ObjectId(result.attributionId),
      detail: {
        brandId: brandId.toString(),
        orderId: orderId.toString(),
        campaignCreatorId: body.campaignCreatorId,
        reason: body.reason,
        superseded: result.supersededId,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json(result);
  }),
);

const withdrawSchema = z.object({
  reason: z.string().min(1, 'say why this was withdrawn').max(500),
});

attributionRouter.post(
  '/brands/:brandId/orders/:orderId/attribution/withdraw',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const orderId = requireObjectId(req.params.orderId, 'order');
    const body = parseBody(withdrawSchema, req);
    const { operator } = getOperator(req);

    const result = await withdrawAttribution({
      brandId,
      orderId,
      operatorId: operator._id,
      reason: body.reason,
    });
    if (!result.withdrew) {
      throw ApiError.notFound('no_attribution', 'That order has no live attribution.');
    }

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.attributionWithdrawn,
      subjectKind: 'Order',
      subjectId: orderId,
      detail: { brandId: brandId.toString(), reason: body.reason },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(result);
  }),
);

/**
 * The full chain for one order, oldest first.
 *
 * This is what gets shown when a brand or a creator disputes who was credited.
 * Superseded rows are the point of it, not clutter.
 */
attributionRouter.get(
  '/brands/:brandId/orders/:orderId/attribution-history',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const orderId = requireObjectId(req.params.orderId, 'order');

    const rows = await AttributionModel.find({ orderId, brandId })
      .sort({ createdAt: 1 })
      .lean();

    res.json({
      history: rows.map((r) => ({
        id: r._id.toString(),
        method: r.method,
        confidence: r.confidence,
        creatorId: r.creatorId.toString(),
        campaignCreatorId: r.campaignCreatorId.toString(),
        attributedAt: r.attributedAt,
        rateAppliedBps: r.rateAppliedBps,
        rateBasis: r.rateBasis,
        basisAmount: r.basisAmount,
        windowHoursUsed: r.windowHoursUsed,
        assignedByOperatorId: r.assignedByOperatorId?.toString() ?? null,
        note: r.note,
        supersededAt: r.supersededAt,
        supersededReason: r.supersededReason,
        // Superseded by itself means withdrawn, not replaced.
        withdrawn: r.supersededBy != null && r.supersededBy.toString() === r._id.toString(),
        live: r.supersededBy == null,
      })),
    });
  }),
);
