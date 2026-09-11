import { Types } from 'mongoose';
import {
  calculateCommission,
  calculateReversal,
  getBalance,
  outstandingReversal,
  sumByCurrency,
  type LedgerBalance,
  type Money,
} from '@anton/shared';
import { AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { OrderModel } from '../db/models/Order.js';
import { CampaignCreatorModel, CampaignModel } from '../db/models/index.js';
import { ApiError } from '../lib/errors.js';

/**
 * Resolves a campaign participation and proves it belongs to this brand.
 *
 * The tenant check is here rather than at each call site: an operator passing
 * another brand's join id must not be able to post money against it, and that
 * has to be true of every path, not the ones someone remembered.
 */
async function requireJoinForBrand(
  campaignCreatorId: Types.ObjectId,
  brandId: Types.ObjectId,
): Promise<{ creatorId: Types.ObjectId; campaignId: Types.ObjectId }> {
  const join = await CampaignCreatorModel.findById(campaignCreatorId).lean();
  if (!join) throw ApiError.notFound('join_not_found', 'No such campaign participation.');

  const campaign = await CampaignModel.findById(join.campaignId).select('brandId').lean();
  if (!campaign || campaign.brandId.toString() !== brandId.toString()) {
    throw ApiError.notFound('join_not_found', 'No such campaign participation for this brand.');
  }
  return { creatorId: join.creatorId, campaignId: join.campaignId };
}

/**
 * Turning attributions into ledger entries.
 *
 * Anton calculates money and never moves it. Everything here writes rows saying
 * what is owed; nothing here initiates a payment, holds a balance, or touches
 * funds. The brand pays the creator directly.
 *
 * Two guarantees the rest of the product leans on:
 *
 *   Replay is a no-op. Running this twice over the same attributions produces
 *   the same ledger, enforced by a unique index on (attributionId) for accruals
 *   and by netting reversals against what has already been reversed.
 *
 *   Nothing is ever updated or deleted. A correction is a new entry. The models
 *   refuse update and delete outright, so this is a property of the storage
 *   rather than a convention this file happens to follow.
 */

export interface PostResult {
  readonly accrualsCreated: number;
  readonly accrualsSkipped: number;
  readonly reversalsCreated: number;
  readonly reversalsUnchanged: number;
  readonly attributionsConsidered: number;
  /** Attributions whose accrual was withdrawn because the attribution was. */
  readonly orphanedReversals: number;
}

interface LoadedOrder {
  _id: Types.ObjectId;
  total: { amountMinor: number; currency: string };
  subtotal: { amountMinor: number; currency: string };
  status: string;
  refundedAmount?: { amountMinor: number; currency: string } | null;
}

/**
 * Posts the ledger for a brand.
 *
 * Walks every live attribution, accrues what has not been accrued, and reverses
 * what the orders say came back. Both halves are idempotent, so this is safe to
 * call after every ingest and safe to call again when someone wonders whether
 * it ran.
 */
export async function postCommission(params: {
  brandId: Types.ObjectId;
  createdBy?: string;
}): Promise<PostResult> {
  const createdBy = params.createdBy ?? 'system';

  const attributions = await AttributionModel.find({
    brandId: params.brandId,
    supersededBy: null,
  }).lean();

  const orders = (await OrderModel.find({
    _id: { $in: attributions.map((a) => a.orderId) },
  })
    .select('_id total subtotal status refundedAmount')
    .lean()) as unknown as LoadedOrder[];
  const orderById = new Map(orders.map((o) => [o._id.toString(), o]));

  const entries = await CommissionEntryModel.find({ brandId: params.brandId }).lean();
  const accrualByAttribution = new Map(
    entries.filter((e) => e.type === 'accrual').map((e) => [e.attributionId?.toString() ?? '', e]),
  );
  const reversedByAttribution = new Map<string, number>();
  for (const e of entries) {
    if (e.type !== 'reversal') continue;
    const key = e.attributionId?.toString() ?? '';
    reversedByAttribution.set(key, (reversedByAttribution.get(key) ?? 0) + e.amount.amountMinor);
  }

  let accrualsCreated = 0;
  let accrualsSkipped = 0;
  let reversalsCreated = 0;
  let reversalsUnchanged = 0;

  for (const attribution of attributions) {
    const order = orderById.get(attribution.orderId.toString());
    if (!order) {
      // The order was rolled back under the attribution. Nothing to accrue.
      accrualsSkipped += 1;
      continue;
    }

    const key = attribution._id.toString();
    let accrual = accrualByAttribution.get(key);

    if (!accrual) {
      /**
       * The rate and basis come off the ATTRIBUTION, not off the asset.
       *
       * The asset's rate may have been corrected since; the attribution row
       * froze the terms in force when the order was credited, and that is what
       * the creator agreed to.
       */
      const commission = calculateCommission({
        basis: attribution.basisAmount,
        rateBps: attribution.rateAppliedBps,
        rateBasis: attribution.rateBasis,
      });

      try {
        const created = await CommissionEntryModel.create({
          creatorId: attribution.creatorId,
          campaignId: attribution.campaignId,
          campaignCreatorId: attribution.campaignCreatorId,
          brandId: params.brandId,
          orderId: attribution.orderId,
          attributionId: attribution._id,
          type: 'accrual',
          amount: commission.amount,
          rateAppliedBps: attribution.rateAppliedBps,
          rateBasis: attribution.rateBasis,
          basisAmount: attribution.basisAmount,
          workings: commission.workings,
          createdBy,
        });
        accrual = created.toObject() as unknown as (typeof entries)[number];
        accrualsCreated += 1;
      } catch (err: unknown) {
        // The unique index rejected it: something else accrued it first. That
        // is the index doing its job, not an error worth propagating.
        if (!isDuplicateKey(err)) throw err;
        const found = await CommissionEntryModel.findOne({
          attributionId: attribution._id,
          type: 'accrual',
        }).lean();
        if (!found) throw err;
        accrual = found;
        accrualsSkipped += 1;
      }
    } else {
      accrualsSkipped += 1;
    }

    /* ---- reversals */

    const refunded: Money =
      order.status === 'cancelled'
        ? // A cancelled order was never a sale, so the whole accrual comes back.
          { amountMinor: attribution.basisAmount.amountMinor, currency: attribution.basisAmount.currency }
        : (order.refundedAmount ?? { amountMinor: 0, currency: attribution.basisAmount.currency });

    if (refunded.amountMinor <= 0) continue;

    const target = calculateReversal({
      accrued: accrual.amount,
      originalBasis: attribution.basisAmount,
      refunded,
    });

    const already: Money = {
      amountMinor: reversedByAttribution.get(key) ?? 0,
      currency: accrual.amount.currency,
    };
    const delta = outstandingReversal(target, already);

    if (delta.amountMinor === 0) {
      reversalsUnchanged += 1;
      continue;
    }

    await CommissionEntryModel.create({
      creatorId: attribution.creatorId,
      campaignId: attribution.campaignId,
      campaignCreatorId: attribution.campaignCreatorId,
      brandId: params.brandId,
      orderId: attribution.orderId,
      attributionId: attribution._id,
      type: 'reversal',
      amount: delta,
      rateAppliedBps: attribution.rateAppliedBps,
      rateBasis: attribution.rateBasis,
      basisAmount: attribution.basisAmount,
      workings: target.workings,
      reason:
        order.status === 'cancelled'
          ? 'the order was cancelled'
          : `the brand refunded ${refunded.amountMinor} of ${attribution.basisAmount.amountMinor}`,
      createdBy,
    });
    reversalsCreated += 1;
  }

  /**
   * An accrual whose attribution has since been withdrawn.
   *
   * The accrual cannot be deleted — the ledger is append-only — so it is
   * reversed in full instead. Doing nothing would leave a creator owed money
   * for an order somebody decided was not theirs.
   */
  const liveIds = new Set(attributions.map((a) => a._id.toString()));
  let orphanedReversals = 0;

  for (const entry of entries) {
    if (entry.type !== 'accrual') continue;
    const key = entry.attributionId?.toString() ?? '';
    if (liveIds.has(key)) continue;

    const already = reversedByAttribution.get(key) ?? 0;
    const outstanding = -entry.amount.amountMinor - already;
    if (outstanding === 0) continue;

    await CommissionEntryModel.create({
      creatorId: entry.creatorId,
      campaignId: entry.campaignId,
      campaignCreatorId: entry.campaignCreatorId,
      brandId: params.brandId,
      orderId: entry.orderId,
      attributionId: entry.attributionId,
      type: 'reversal',
      amount: { amountMinor: outstanding, currency: entry.amount.currency },
      rateAppliedBps: entry.rateAppliedBps,
      rateBasis: entry.rateBasis,
      basisAmount: entry.basisAmount,
      workings: `attribution withdrawn: exact negation of ${entry.amount.amountMinor}`,
      reason: 'the attribution this accrual rests on was withdrawn or reassigned',
      createdBy,
    });
    orphanedReversals += 1;
  }

  return {
    accrualsCreated,
    accrualsSkipped,
    reversalsCreated,
    reversalsUnchanged,
    attributionsConsidered: attributions.length,
    orphanedReversals,
  };
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000;
}

/* --------------------------------------------------------------- reading */

export interface CreatorEarnings {
  readonly creatorId: string;
  readonly campaignId: string | null;
  readonly balance: LedgerBalance;
  readonly paid: { total: Money | null; byCurrency: readonly Money[] };
  readonly outstanding: { total: Money | null; byCurrency: readonly Money[] };
  readonly entryCount: number;
}

/**
 * What one creator is owed.
 *
 * The balance is summed from the entries every time it is asked for. There is
 * no stored total to drift, and the arithmetic is the same arithmetic the
 * creator sees on their own statement.
 */
export async function creatorEarnings(params: {
  creatorId: Types.ObjectId;
  campaignId?: Types.ObjectId;
  brandId?: Types.ObjectId;
}): Promise<CreatorEarnings> {
  const filter: Record<string, unknown> = { creatorId: params.creatorId };
  if (params.campaignId) filter.campaignId = params.campaignId;
  if (params.brandId) filter.brandId = params.brandId;

  const entries = await CommissionEntryModel.find(filter).sort({ createdAt: 1 }).lean();
  const balance = getBalance(
    entries.map((e) => ({
      id: e._id.toString(),
      type: e.type as 'accrual' | 'reversal' | 'adjustment',
      amount: e.amount,
      createdAt: e.createdAt,
    })),
  );

  const paymentFilter: Record<string, unknown> = { creatorId: params.creatorId, voidedAt: null };
  if (params.campaignId) paymentFilter.campaignId = params.campaignId;
  if (params.brandId) paymentFilter.brandId = params.brandId;
  const payments = await PaymentRecordModel.find(paymentFilter).lean();

  const paidByCurrency = sumByCurrency(payments.map((p) => p.amount));
  const paidTotal = paidByCurrency.length === 1 ? paidByCurrency[0] ?? null : null;

  /**
   * Outstanding is earned minus paid, and it is only a single figure when both
   * sides are in one currency. Mixing currencies into one number would be a
   * made-up exchange rate, so it comes back as null with a per-currency
   * breakdown instead.
   */
  const outstandingByCurrency: Money[] = [];
  const currencies = new Set([
    ...balance.byCurrency.map((m) => m.currency),
    ...paidByCurrency.map((m) => m.currency),
  ]);
  for (const currency of [...currencies].sort()) {
    const earned = balance.byCurrency.find((m) => m.currency === currency)?.amountMinor ?? 0;
    const paid = paidByCurrency.find((m) => m.currency === currency)?.amountMinor ?? 0;
    outstandingByCurrency.push({ amountMinor: earned - paid, currency });
  }

  return {
    creatorId: params.creatorId.toString(),
    campaignId: params.campaignId?.toString() ?? null,
    balance,
    paid: { total: paidTotal, byCurrency: paidByCurrency },
    outstanding: {
      total: outstandingByCurrency.length === 1 ? outstandingByCurrency[0] ?? null : null,
      byCurrency: outstandingByCurrency,
    },
    entryCount: entries.length,
  };
}

/* -------------------------------------------------------------- writing */

/**
 * A manual adjustment: a bonus, a goodwill payment, a correction.
 *
 * A new entry, never an edit, and the reason is required at the schema. An
 * unexplained adjustment to someone's earnings is indistinguishable from a
 * mistake — or from fraud — when it is read back a year later.
 */
export async function recordAdjustment(params: {
  brandId: Types.ObjectId;
  campaignCreatorId: Types.ObjectId;
  amount: Money;
  reason: string;
  operatorId: Types.ObjectId;
  operatorLabel: string;
}): Promise<{ entryId: string }> {
  const join = await requireJoinForBrand(params.campaignCreatorId, params.brandId);

  const doc = await CommissionEntryModel.create({
    creatorId: join.creatorId,
    campaignId: join.campaignId,
    campaignCreatorId: params.campaignCreatorId,
    brandId: params.brandId,
    orderId: null,
    attributionId: null,
    type: 'adjustment',
    amount: params.amount,
    // An adjustment is not derived from a rate; recording 0 against the amount
    // itself keeps the entry re-derivable without pretending a rate applied.
    rateAppliedBps: 0,
    rateBasis: 'order_subtotal',
    basisAmount: { amountMinor: 0, currency: params.amount.currency },
    workings: `manual adjustment of ${params.amount.amountMinor}`,
    reason: params.reason,
    createdBy: params.operatorLabel,
    createdByOperatorId: params.operatorId,
  });

  return { entryId: doc._id.toString() };
}

/**
 * Records that the brand says it paid.
 *
 * Not a transfer. Anton holds no funds and initiates nothing; this is the
 * brand's own statement, dated, so that "owed" and "paid" can be shown side by
 * side and reconciled by a human.
 */
export async function recordPayment(params: {
  brandId: Types.ObjectId;
  campaignCreatorId: Types.ObjectId;
  amount: Money;
  paidAt: Date;
  method: string | null;
  reference: string | null;
  note: string | null;
  operatorId: Types.ObjectId;
}): Promise<{ paymentId: string }> {
  const join = await requireJoinForBrand(params.campaignCreatorId, params.brandId);

  const doc = await PaymentRecordModel.create({
    creatorId: join.creatorId,
    campaignId: join.campaignId,
    brandId: params.brandId,
    amount: params.amount,
    paidAt: params.paidAt,
    method: params.method,
    reference: params.reference,
    note: params.note,
    recordedByOperatorId: params.operatorId,
    recordedAt: new Date(),
  });

  return { paymentId: doc._id.toString() };
}
