import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  formatMoney,
  objectIdSchema,
  runningBalance,
  toCsv,
  type Money,
} from '@anton/shared';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { OrderModel } from '../db/models/Order.js';
import {
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
} from '../db/models/index.js';
import { getOperator, requireFreshReauth, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { creatorEarnings, postCommission, recordAdjustment, recordPayment } from '../commission/post.js';

export const commissionRouter: Router = Router();
commissionRouter.use(requireOperator);

/**
 * The commission ledger, as the operator sees it.
 *
 * Anton calculates money and never moves it. Nothing on these routes initiates
 * a payment or holds a balance — a "payment" here is a record of what the brand
 * says it already did, elsewhere, directly.
 */

async function requireBrand(brandIdRaw: unknown): Promise<Types.ObjectId> {
  if (typeof brandIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(brandIdRaw)) {
    throw ApiError.badRequest('bad_brand_id', 'Not a valid brand id.');
  }
  const brand = await BrandModel.findById(brandIdRaw).select('_id').lean();
  if (!brand) throw ApiError.notFound('brand_not_found', 'No such brand.');
  return brand._id;
}

/** Money on the wire: integer minor units plus an ISO code, never a float. */
const moneyInputSchema = z.object({
  amountMinor: z.number().int(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'a three-letter ISO currency code'),
});

/* ----------------------------------------------------------------- post */

commissionRouter.post(
  '/brands/:brandId/commission/post',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    await enforceRateLimit(
      { bucket: 'commission_post', subject: brandId.toString(), limit: 60, windowMs: HOUR_MS },
      'The ledger has been posted too many times for this brand in the last hour.',
    );

    const result = await postCommission({ brandId, createdBy: operator.email });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.commissionPosted,
      subjectKind: 'Brand',
      subjectId: brandId,
      detail: { brandId: brandId.toString(), ...result },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(result);
  }),
);

/* -------------------------------------------------------------- balances */

/**
 * Every creator's position on this brand.
 *
 * Earned is summed from the ledger on every read. Paid is what the brand has
 * said it paid. Outstanding is the difference, and it is null rather than
 * invented when the two sides are not in one currency.
 */
commissionRouter.get(
  '/brands/:brandId/commission/balances',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);

    const entries = await CommissionEntryModel.find({ brandId }).lean();
    const payments = await PaymentRecordModel.find({ brandId, voidedAt: null }).lean();

    type Bucket = {
      creatorId: string;
      campaignId: string;
      earned: Map<string, number>;
      paid: Map<string, number>;
      entries: number;
    };
    const buckets = new Map<string, Bucket>();
    const keyOf = (creatorId: string, campaignId: string): string => `${creatorId}:${campaignId}`;

    const bucketFor = (creatorId: string, campaignId: string): Bucket => {
      const key = keyOf(creatorId, campaignId);
      const existing = buckets.get(key);
      if (existing) return existing;
      const made: Bucket = {
        creatorId,
        campaignId,
        earned: new Map(),
        paid: new Map(),
        entries: 0,
      };
      buckets.set(key, made);
      return made;
    };

    for (const e of entries) {
      const b = bucketFor(e.creatorId.toString(), e.campaignId.toString());
      b.earned.set(
        e.amount.currency,
        (b.earned.get(e.amount.currency) ?? 0) + e.amount.amountMinor,
      );
      b.entries += 1;
    }
    for (const p of payments) {
      const b = bucketFor(p.creatorId.toString(), p.campaignId.toString());
      b.paid.set(p.amount.currency, (b.paid.get(p.amount.currency) ?? 0) + p.amount.amountMinor);
    }

    const creatorIds = [...new Set([...buckets.values()].map((b) => b.creatorId))];
    const campaignIds = [...new Set([...buckets.values()].map((b) => b.campaignId))];
    const [creators, campaigns] = await Promise.all([
      CreatorModel.find({ _id: { $in: creatorIds } }).select('displayName handles').lean(),
      CampaignModel.find({ _id: { $in: campaignIds } }).select('name currency').lean(),
    ]);
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c]));

    const rows = [...buckets.values()].map((b) => {
      const currencies = [...new Set([...b.earned.keys(), ...b.paid.keys()])].sort();
      const breakdown = currencies.map((currency) => {
        const earned = b.earned.get(currency) ?? 0;
        const paid = b.paid.get(currency) ?? 0;
        return {
          currency,
          earned: { amountMinor: earned, currency },
          paid: { amountMinor: paid, currency },
          outstanding: { amountMinor: earned - paid, currency },
        };
      });

      /**
       * A single headline figure only when there is one currency. Adding two
       * currencies together would require an exchange rate Anton does not have
       * and must not guess.
       */
      const single = breakdown.length === 1 ? breakdown[0] : null;

      return {
        creatorId: b.creatorId,
        creatorName: creatorById.get(b.creatorId)?.displayName ?? null,
        campaignId: b.campaignId,
        campaignName: campaignById.get(b.campaignId)?.name ?? null,
        entryCount: b.entries,
        earned: single?.earned ?? null,
        paid: single?.paid ?? null,
        outstanding: single?.outstanding ?? null,
        outstandingFormatted: single ? formatMoney(single.outstanding) : null,
        unavailableReason:
          single === null && breakdown.length > 1
            ? 'this creator has earnings in more than one currency, so there is no single total'
            : null,
        breakdown,
      };
    });

    rows.sort((a, b) => (b.outstanding?.amountMinor ?? 0) - (a.outstanding?.amountMinor ?? 0));
    res.json({ balances: rows });
  }),
);

/**
 * One creator's full statement.
 *
 * The running balance is included so every line can be shown with the total it
 * produced. A figure a creator cannot follow line by line is a figure they
 * cannot challenge.
 */
commissionRouter.get(
  '/brands/:brandId/creators/:creatorId/ledger',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const creatorIdRaw = req.params.creatorId;
    if (typeof creatorIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const creatorId = new Types.ObjectId(creatorIdRaw);

    const campaignIdRaw = req.query.campaignId;
    const campaignId =
      typeof campaignIdRaw === 'string' && /^[a-f0-9]{24}$/i.test(campaignIdRaw)
        ? new Types.ObjectId(campaignIdRaw)
        : undefined;

    const earnings = await creatorEarnings({ creatorId, brandId, ...(campaignId ? { campaignId } : {}) });

    const filter: Record<string, unknown> = { brandId, creatorId };
    if (campaignId) filter.campaignId = campaignId;
    const entries = await CommissionEntryModel.find(filter).sort({ createdAt: 1 }).lean();

    const orders = await OrderModel.find({ _id: { $in: entries.map((e) => e.orderId) } })
      .select('externalOrderId orderedAt total')
      .lean();
    const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

    /**
     * Running balances are computed per currency.
     *
     * A single running total across currencies would need an exchange rate
     * Anton does not have; runningBalance refuses outright, so the entries are
     * split first and each currency carries its own column.
     */
    const balanceAfter = new Map<string, Money>();
    const byCurrency = new Map<string, typeof entries>();
    for (const e of entries) {
      const list = byCurrency.get(e.amount.currency) ?? [];
      list.push(e);
      byCurrency.set(e.amount.currency, list);
    }
    for (const list of byCurrency.values()) {
      for (const r of runningBalance(
        list.map((e) => ({
          id: e._id.toString(),
          type: e.type as 'accrual' | 'reversal' | 'adjustment',
          amount: e.amount,
          createdAt: e.createdAt,
        })),
      )) {
        if (r.entry.id) balanceAfter.set(r.entry.id, r.balanceAfter);
      }
    }

    res.json({
      earnings,
      entries: entries.map((e) => {
        const order = orderById.get(e.orderId?.toString() ?? '');
        return {
          id: e._id.toString(),
          type: e.type,
          amount: e.amount,
          amountFormatted: formatMoney(e.amount),
          balanceAfter: balanceAfter.get(e._id.toString()) ?? null,
          rateAppliedBps: e.rateAppliedBps,
          rateBasis: e.rateBasis,
          basisAmount: e.basisAmount,
          workings: e.workings,
          reason: e.reason,
          orderId: e.orderId?.toString() ?? null,
          externalOrderId: order?.externalOrderId ?? null,
          orderedAt: order?.orderedAt ?? null,
          attributionId: e.attributionId?.toString() ?? null,
          createdAt: e.createdAt,
          createdBy: e.createdBy,
        };
      }),
    });
  }),
);

/* ----------------------------------------------------------- adjustments */

const adjustmentSchema = z.object({
  campaignCreatorId: objectIdSchema,
  amount: moneyInputSchema,
  reason: z.string().min(1, 'an adjustment must carry a reason').max(500),
});

commissionRouter.post(
  '/brands/:brandId/commission/adjustments',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const body = parseBody(adjustmentSchema, req);
    const { operator } = getOperator(req);

    if (body.amount.amountMinor === 0) {
      throw ApiError.badRequest('zero_adjustment', 'An adjustment of zero changes nothing.');
    }

    const result = await recordAdjustment({
      brandId,
      campaignCreatorId: new Types.ObjectId(body.campaignCreatorId),
      amount: body.amount as Money,
      reason: body.reason,
      operatorId: operator._id,
      operatorLabel: operator.email,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.commissionAdjusted,
      subjectKind: 'CommissionEntry',
      subjectId: new Types.ObjectId(result.entryId),
      detail: {
        brandId: brandId.toString(),
        campaignCreatorId: body.campaignCreatorId,
        amountMinor: body.amount.amountMinor,
        currency: body.amount.currency,
        reason: body.reason,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json(result);
  }),
);

/* -------------------------------------------------------------- payments */

const paymentSchema = z.object({
  campaignCreatorId: objectIdSchema,
  amount: moneyInputSchema.refine((m) => m.amountMinor > 0, {
    message: 'a payment record is for a positive amount',
  }),
  paidAt: z.coerce.date(),
  method: z.string().max(60).nullable().default(null),
  reference: z.string().max(120).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});

/**
 * Records a payment the brand says it made.
 *
 * This moves no money. Anton has no wallet, holds no balance and initiates no
 * transfer; the brand pays the creator directly and this is the note of it.
 */
commissionRouter.post(
  '/brands/:brandId/commission/payments',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const body = parseBody(paymentSchema, req);
    const { operator } = getOperator(req);

    if (body.paidAt.getTime() > Date.now() + 24 * HOUR_MS) {
      throw ApiError.badRequest(
        'future_payment',
        'A payment record is a record of something that happened, not a plan.',
      );
    }

    const result = await recordPayment({
      brandId,
      campaignCreatorId: new Types.ObjectId(body.campaignCreatorId),
      amount: body.amount as Money,
      paidAt: body.paidAt,
      method: body.method,
      reference: body.reference,
      note: body.note,
      operatorId: operator._id,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.paymentRecorded,
      subjectKind: 'PaymentRecord',
      subjectId: new Types.ObjectId(result.paymentId),
      detail: {
        brandId: brandId.toString(),
        campaignCreatorId: body.campaignCreatorId,
        amountMinor: body.amount.amountMinor,
        currency: body.amount.currency,
        paidAt: body.paidAt.toISOString(),
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json(result);
  }),
);

commissionRouter.get(
  '/brands/:brandId/commission/payments',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const payments = await PaymentRecordModel.find({ brandId }).sort({ paidAt: -1 }).limit(500).lean();

    res.json({
      payments: payments.map((p) => ({
        id: p._id.toString(),
        creatorId: p.creatorId.toString(),
        campaignId: p.campaignId.toString(),
        amount: p.amount,
        amountFormatted: formatMoney(p.amount),
        paidAt: p.paidAt,
        method: p.method,
        reference: p.reference,
        note: p.note,
        recordedAt: p.recordedAt,
        voidedAt: p.voidedAt,
        voidedReason: p.voidedReason,
      })),
    });
  }),
);

const voidSchema = z.object({ reason: z.string().min(1, 'say why').max(500) });

/**
 * Retracts a payment record.
 *
 * The row survives, marked void. A payment the brand claimed and then withdrew
 * is a fact about the conversation, and deleting it would leave the creator
 * with no evidence the claim was ever made.
 */
commissionRouter.post(
  '/brands/:brandId/commission/payments/:paymentId/void',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const paymentIdRaw = req.params.paymentId;
    if (typeof paymentIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(paymentIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid payment id.');
    }
    const body = parseBody(voidSchema, req);
    const { operator } = getOperator(req);

    const updated = await PaymentRecordModel.findOneAndUpdate(
      { _id: paymentIdRaw, brandId, voidedAt: null },
      {
        $set: {
          voidedAt: new Date(),
          voidedReason: body.reason,
          voidedByOperatorId: operator._id,
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      throw ApiError.notFound('payment_not_found', 'No such open payment record for this brand.');
    }

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.paymentVoided,
      subjectKind: 'PaymentRecord',
      subjectId: updated._id,
      detail: { brandId: brandId.toString(), reason: body.reason },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true, voidedAt: updated.voidedAt });
  }),
);

/* ---------------------------------------------------------------- export */

/**
 * The statement a brand hands to their finance team.
 *
 * Behind a fresh password check, and every cell neutralised against formula
 * injection: a creator's display name is user-supplied text, and a name
 * beginning with `=` becomes an executable formula the moment this lands in
 * Excel.
 */
commissionRouter.get(
  '/brands/:brandId/commission/export',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    const entries = await CommissionEntryModel.find({ brandId }).sort({ createdAt: 1 }).limit(50_000).lean();
    const [creators, campaigns, orders] = await Promise.all([
      CreatorModel.find({ _id: { $in: entries.map((e) => e.creatorId) } }).select('displayName').lean(),
      CampaignModel.find({ _id: { $in: entries.map((e) => e.campaignId) } }).select('name').lean(),
      OrderModel.find({ _id: { $in: entries.map((e) => e.orderId) } }).select('externalOrderId').lean(),
    ]);
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c.displayName]));
    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c.name]));
    const orderById = new Map(orders.map((o) => [o._id.toString(), o.externalOrderId]));

    const rows = entries.map((e) => ({
      createdAt: e.createdAt.toISOString(),
      creator: creatorById.get(e.creatorId.toString()) ?? '',
      campaign: campaignById.get(e.campaignId.toString()) ?? '',
      type: e.type,
      currency: e.amount.currency,
      amountMinor: e.amount.amountMinor,
      rateBps: e.rateAppliedBps,
      rateBasis: e.rateBasis,
      basisMinor: e.basisAmount.amountMinor,
      externalOrderId: orderById.get(e.orderId?.toString() ?? '') ?? '',
      workings: e.workings ?? '',
      reason: e.reason ?? '',
      createdBy: e.createdBy,
    }));

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.commissionExported,
      detail: { brandId: brandId.toString(), rows: rows.length },
      ipHash: hashIp(clientIp(req)),
    });

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="anton-commission.csv"');
    res.send(
      toCsv(rows, [
        'createdAt',
        'creator',
        'campaign',
        'type',
        'currency',
        'amountMinor',
        'rateBps',
        'rateBasis',
        'basisMinor',
        'externalOrderId',
        'workings',
        'reason',
        'createdBy',
      ]),
    );
  }),
);

/* ------------------------------------------------ reconciliation helper */

/**
 * Where `CampaignCreator.status === 'paid'` disagrees with the ledger.
 *
 * Two systems recording the same fact will drift, and the one a creator reads
 * must not be the one that is wrong. This does not reconcile them — it says
 * where they disagree and leaves the judgement to a person.
 */
commissionRouter.get(
  '/brands/:brandId/commission/reconciliation',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);

    const campaigns = await CampaignModel.find({ brandId }).select('_id name').lean();
    const joins = await CampaignCreatorModel.find({
      campaignId: { $in: campaigns.map((c) => c._id) },
    }).lean();

    const payments = await PaymentRecordModel.find({ brandId, voidedAt: null }).lean();
    const entries = await CommissionEntryModel.find({ brandId }).lean();

    const paidByPair = new Map<string, number>();
    for (const p of payments) {
      const key = `${p.creatorId.toString()}:${p.campaignId.toString()}`;
      paidByPair.set(key, (paidByPair.get(key) ?? 0) + p.amount.amountMinor);
    }
    const earnedByPair = new Map<string, number>();
    for (const e of entries) {
      const key = `${e.creatorId.toString()}:${e.campaignId.toString()}`;
      earnedByPair.set(key, (earnedByPair.get(key) ?? 0) + e.amount.amountMinor);
    }

    const disagreements = joins
      .map((j) => {
        const key = `${j.creatorId.toString()}:${j.campaignId.toString()}`;
        const paid = paidByPair.get(key) ?? 0;
        const earned = earnedByPair.get(key) ?? 0;
        const markedPaid = j.status === 'paid';
        const hasPaymentRecord = paid > 0;
        const outstanding = earned - paid;

        if (markedPaid && !hasPaymentRecord) {
          return {
            campaignCreatorId: j._id.toString(),
            creatorId: j.creatorId.toString(),
            campaignId: j.campaignId.toString(),
            problem: 'marked_paid_without_record' as const,
            detail: 'The participation is marked paid, but no payment has been recorded.',
            earnedMinor: earned,
            paidMinor: paid,
            outstandingMinor: outstanding,
          };
        }
        if (markedPaid && outstanding > 0) {
          return {
            campaignCreatorId: j._id.toString(),
            creatorId: j.creatorId.toString(),
            campaignId: j.campaignId.toString(),
            problem: 'marked_paid_but_owed' as const,
            detail: 'The participation is marked paid, but the ledger still shows money owed.',
            earnedMinor: earned,
            paidMinor: paid,
            outstandingMinor: outstanding,
          };
        }
        if (!markedPaid && earned > 0 && outstanding <= 0) {
          return {
            campaignCreatorId: j._id.toString(),
            creatorId: j.creatorId.toString(),
            campaignId: j.campaignId.toString(),
            problem: 'settled_but_not_marked' as const,
            detail: 'Everything owed has been paid, but the participation is not marked paid.',
            earnedMinor: earned,
            paidMinor: paid,
            outstandingMinor: outstanding,
          };
        }
        return null;
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);

    res.json({ checked: joins.length, disagreements });
  }),
);
