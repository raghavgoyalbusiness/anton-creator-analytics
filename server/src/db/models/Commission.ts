import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { BPS_PER_UNIT, COMMISSION_ENTRY_TYPES, RATE_BASES } from '@anton/shared';
import { signedMoneySchema, moneySchema } from './shared-subdocs.js';

/**
 * The commission ledger.
 *
 * Append-only, without exception. There is no update path and no delete path in
 * this file, and none anywhere else in the codebase: a correction is a new
 * entry of type `reversal` or `adjustment`. A balance is always the sum of the
 * entries, never a stored field, because a stored balance and its entries can
 * disagree — and when they do, nobody can tell which one lied.
 *
 * Anton calculates money. It never moves it. Nothing here instructs a payment;
 * these rows say what is owed, and the brand pays the creator directly.
 */
const commissionEntrySchema = new Schema(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    campaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    attributionId: { type: Schema.Types.ObjectId, ref: 'Attribution', default: null },

    type: { type: String, required: true, enum: COMMISSION_ENTRY_TYPES },

    /** Negative for reversals. Signed on purpose — the sum is the balance. */
    amount: { type: signedMoneySchema, required: true },

    rateAppliedBps: {
      type: Number,
      required: true,
      min: 0,
      max: BPS_PER_UNIT,
      validate: { validator: Number.isInteger, message: 'rates are whole basis points' },
    },
    rateBasis: { type: String, required: true, enum: RATE_BASES },
    /** The order figure the rate was applied to, so the entry can be re-derived. */
    basisAmount: { type: moneySchema, required: true },

    /**
     * Rendered beside the figure in the creator's own view.
     *
     * A creator who cannot see how a number was reached has no way to
     * challenge it, and a number nobody can challenge is one nobody trusts.
     */
    workings: { type: String, default: null, maxlength: 400 },

    /** Required for adjustments and reversals; enforced below. */
    reason: { type: String, default: null, maxlength: 500 },

    createdBy: { type: String, required: true, maxlength: 120 },
    createdByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'commission_entries' },
);

/**
 * One accrual per attribution.
 *
 * The constraint that makes re-running safe: an attribution that has already
 * been accrued cannot be accrued twice, so replaying a run is a no-op at the
 * database rather than on trust. Partial on type so reversals and adjustments,
 * which may legitimately repeat against one attribution, are unaffected.
 */
commissionEntrySchema.index(
  { attributionId: 1 },
  { unique: true, partialFilterExpression: { type: 'accrual' } },
);

commissionEntrySchema.index({ creatorId: 1, campaignId: 1, createdAt: 1 });
commissionEntrySchema.index({ brandId: 1, createdAt: -1 });
commissionEntrySchema.index({ orderId: 1, type: 1 });

commissionEntrySchema.pre('validate', function checkEntry(next) {
  if (this.type === 'accrual' && this.amount.amountMinor < 0) {
    next(new Error('an accrual is never negative; a clawback is a reversal'));
    return;
  }
  if (this.type === 'reversal' && this.amount.amountMinor > 0) {
    next(new Error('a reversal is never positive'));
    return;
  }
  if (this.type !== 'accrual' && (this.reason ?? '').trim().length === 0) {
    next(new Error('a reversal or adjustment must carry a reason'));
    return;
  }
  if (this.amount.currency !== this.basisAmount?.currency) {
    next(new Error('the entry and its basis must share a currency'));
    return;
  }
  next();
});

/**
 * Deliberately blocked.
 *
 * The append-only guarantee is the whole point of this collection, so it is
 * enforced here rather than left to everyone who ever writes a query. Anyone
 * who genuinely needs to change history has to change this file first, which
 * is exactly the amount of friction it deserves.
 */
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  commissionEntrySchema.pre(op, function refuse(next) {
    next(new Error(`the commission ledger is append-only; ${op} is not permitted`));
  });
}

export type CommissionEntryDoc = InferSchemaType<typeof commissionEntrySchema>;
export const CommissionEntryModel: Model<CommissionEntryDoc> = model<CommissionEntryDoc>(
  'CommissionEntry',
  commissionEntrySchema,
);

/* -------------------------------------------------------------- payments */

/**
 * A payment as the BRAND reports it.
 *
 * Anton does not move money, so this is a record of something that happened
 * elsewhere — not an instruction, not a transfer, not a held balance. Recording
 * it here is what lets "owed" and "paid" be shown side by side without Anton
 * ever touching funds.
 *
 * Append-only for the same reason as the ledger: "the brand says it paid £120
 * on the 3rd" is a claim with a date on it, and overwriting it destroys the
 * only evidence of what was said when.
 */
const paymentRecordSchema = new Schema(
  {
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    amount: { type: moneySchema, required: true },
    paidAt: { type: Date, required: true },
    method: { type: String, default: null, maxlength: 60 },
    reference: { type: String, default: null, maxlength: 120 },
    note: { type: String, default: null, maxlength: 500 },

    recordedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
    recordedAt: { type: Date, required: true },

    /**
     * Set when a payment record is retracted. The row itself stays: a payment
     * that was claimed and then withdrawn is a fact about the conversation.
     */
    voidedAt: { type: Date, default: null },
    voidedReason: { type: String, default: null, maxlength: 500 },
    voidedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
  },
  { timestamps: false, collection: 'payment_records' },
);

paymentRecordSchema.index({ creatorId: 1, campaignId: 1, paidAt: -1 });
paymentRecordSchema.index({ brandId: 1, paidAt: -1 });

paymentRecordSchema.pre('validate', function checkPayment(next) {
  if (this.amount.amountMinor <= 0) {
    next(new Error('a payment record is for a positive amount'));
    return;
  }
  next();
});

export type PaymentRecordDoc = InferSchemaType<typeof paymentRecordSchema>;
export const PaymentRecordModel: Model<PaymentRecordDoc> = model<PaymentRecordDoc>(
  'PaymentRecord',
  paymentRecordSchema,
);
