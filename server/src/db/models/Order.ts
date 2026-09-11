import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { CUSTOMER_TYPES, ORDER_SOURCE_IDS, ORDER_STATUSES } from '@anton/shared';
import { moneySchema } from './shared-subdocs.js';

/**
 * An order, as the brand's own commerce platform recorded it.
 *
 * This is the brand's commercial data held on their behalf. Two rules follow
 * and are enforced below rather than left to callers: every query is scoped by
 * brand, and the raw row is never logged at info level because it contains
 * customer data.
 */
const orderSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    externalOrderId: { type: String, required: true, maxlength: 120 },
    source: { type: String, required: true, enum: ORDER_SOURCE_IDS },

    orderedAt: { type: Date, required: true, index: true },
    total: { type: moneySchema, required: true },
    subtotal: { type: moneySchema, required: true },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },

    /**
     * The code as the customer's checkout recorded it, verbatim, plus the
     * folded form used to join against a TrackingAsset.
     */
    discountCodeUsed: { type: String, default: null, maxlength: 64 },
    discountCodeKey: { type: String, default: null, index: true },

    customerType: { type: String, required: true, enum: CUSTOMER_TYPES, default: 'unknown' },
    status: { type: String, required: true, enum: ORDER_STATUSES, default: 'confirmed', index: true },

    refundedAmount: { type: moneySchema, default: null },
    refundedAt: { type: Date, default: null },

    ingestBatchId: { type: Schema.Types.ObjectId, ref: 'IngestBatch', required: true, index: true },
    /** Every batch that has touched this order, oldest first. */
    ingestHistory: {
      type: [
        new Schema(
          { batchId: { type: Schema.Types.ObjectId, required: true }, at: { type: Date, required: true } },
          { _id: false },
        ),
      ],
      default: [],
    },

    /**
     * The uploaded row, verbatim.
     *
     * Kept for the same reason the extraction pipeline keeps raw model output:
     * when a figure is challenged, the source is the only thing that settles
     * it. `select: false` so it never rides along on a list query and into a
     * log line by accident.
     */
    rawRow: { type: Schema.Types.Mixed, required: true, select: false },
  },
  { timestamps: true, collection: 'orders' },
);

/**
 * The idempotency guarantee.
 *
 * Re-uploading the same export must update these rows, never duplicate them.
 * Scoped by source as well as brand so a later Shopify sync of the same order
 * does not collide with the CSV row it supersedes — they are two statements
 * about one order from two systems, and reconciling them is a decision, not an
 * accident.
 */
orderSchema.index({ brandId: 1, source: 1, externalOrderId: 1 }, { unique: true });

/** The attribution lookup. */
orderSchema.index({ brandId: 1, discountCodeKey: 1, orderedAt: -1 });
orderSchema.index({ brandId: 1, orderedAt: -1 });

orderSchema.pre('validate', function checkConsistency(next) {
  if (this.total.currency !== this.subtotal.currency) {
    next(new Error('total and subtotal must share a currency'));
    return;
  }
  if (this.currency !== this.total.currency) {
    next(new Error('the order currency must match its amounts'));
    return;
  }
  if (this.subtotal.amountMinor > this.total.amountMinor) {
    next(new Error('subtotal cannot exceed total'));
    return;
  }
  if (this.refundedAmount && this.refundedAmount.currency !== this.currency) {
    next(new Error('a refund must be in the order currency'));
    return;
  }
  if ((this.status === 'refunded' || this.status === 'partially_refunded') && !this.refundedAmount) {
    next(new Error('a refunded order must record how much was refunded'));
    return;
  }
  next();
});

export type OrderDoc = InferSchemaType<typeof orderSchema>;
export const OrderModel: Model<OrderDoc> = model<OrderDoc>('Order', orderSchema);

/* --------------------------------------------------------------- batches */

const ingestBatchSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    source: { type: String, required: true, enum: ORDER_SOURCE_IDS },
    status: {
      type: String,
      required: true,
      enum: ['previewed', 'committed', 'rolled_back'],
      default: 'previewed',
    },
    uploadedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },

    filename: { type: String, default: null, maxlength: 260 },
    /** Content hash, so re-uploading a byte-identical file is recognisable. */
    fileSha256: { type: String, default: null, match: /^[a-f0-9]{64}$/ },

    rowsParsed: { type: Number, default: 0, min: 0 },
    rowsSkipped: { type: Number, default: 0, min: 0 },
    rowsInserted: { type: Number, default: 0, min: 0 },
    rowsUpdated: { type: Number, default: 0, min: 0 },
    duplicatesInFile: { type: Number, default: 0, min: 0 },

    skipReasons: {
      type: [new Schema({ row: Number, reason: String }, { _id: false })],
      default: [],
    },
    currencies: { type: [String], default: [] },

    dateRangeFrom: { type: Date, default: null },
    dateRangeTo: { type: Date, default: null },

    committedAt: { type: Date, default: null },
    rolledBackAt: { type: Date, default: null },
    rolledBackByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ingest_batches' },
);

ingestBatchSchema.index({ brandId: 1, createdAt: -1 });

export type IngestBatchDoc = InferSchemaType<typeof ingestBatchSchema>;
export const IngestBatchModel: Model<IngestBatchDoc> = model<IngestBatchDoc>(
  'IngestBatch',
  ingestBatchSchema,
);

/* -------------------------------------------------------- saved mappings */

/**
 * A brand's column mapping, saved so they only do it once.
 *
 * Keyed by brand and source. A brand's export format is stable; making them
 * re-map every upload is how a mapping gets done carelessly the fourth time.
 */
const columnMappingSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true },
    source: { type: String, required: true, enum: ORDER_SOURCE_IDS },
    mapping: { type: Schema.Types.Mixed, required: true },
    updatedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
  },
  { timestamps: true, collection: 'column_mappings' },
);

columnMappingSchema.index({ brandId: 1, source: 1 }, { unique: true });

export type ColumnMappingDoc = InferSchemaType<typeof columnMappingSchema>;
export const ColumnMappingModel: Model<ColumnMappingDoc> = model<ColumnMappingDoc>(
  'ColumnMapping',
  columnMappingSchema,
);
