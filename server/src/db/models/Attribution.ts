import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { ATTRIBUTION_METHODS, BPS_PER_UNIT, RATE_BASES } from '@anton/shared';
import { moneySchema } from './shared-subdocs.js';

/**
 * One order assigned to one creator.
 *
 * Never edited in place. When a later rule reassigns an order — an operator
 * correcting a conflict, say — the existing row is marked superseded and a new
 * one is written. The chain of who was credited and when is the thing a brand
 * disputes; overwriting it destroys the only evidence of what was claimed.
 */
const attributionSchema = new Schema(
  {
    // No inline `index: true` on orderId. The unique partial index below uses
    // the same auto-generated name, and a plain one declared here wins the
    // race — leaving the constraint that stops two creators being paid for one
    // sale silently absent. See ensureIndexes() in db/connect.ts.
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    campaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },

    method: { type: String, required: true, enum: ATTRIBUTION_METHODS },
    /** Derived from the method, denormalised so a report never has to compute it. */
    confidence: { type: String, required: true, enum: ['direct', 'inferred'] },

    attributedAt: { type: Date, required: true },
    /** The order figure this attribution is worth, in the order's currency. */
    attributedValue: { type: moneySchema, required: true },

    /**
     * The window in force when this ran, stored on the row.
     *
     * Without it, changing a campaign's window silently rewrites history: last
     * month's report would render different numbers than the one the brand read
     * and signed off.
     */
    windowHoursUsed: { type: Number, default: null, min: 1 },

    /**
     * The commission terms, copied from the asset at attribution time.
     *
     * Same reasoning as copying them onto the asset at issue: the ledger entry
     * must be reproducible from the attribution row alone, years later, after
     * the asset has been revoked and the campaign's defaults have moved on.
     */
    rateAppliedBps: {
      type: Number,
      required: true,
      min: 0,
      max: BPS_PER_UNIT,
      validate: { validator: Number.isInteger, message: 'rates are whole basis points' },
    },
    rateBasis: { type: String, required: true, enum: RATE_BASES },
    basisAmount: { type: moneySchema, required: true },

    trackingAssetId: { type: Schema.Types.ObjectId, ref: 'TrackingAsset', default: null },
    linkClickId: { type: Schema.Types.ObjectId, ref: 'LinkClick', default: null },

    supersededBy: { type: Schema.Types.ObjectId, ref: 'Attribution', default: null },
    supersededAt: { type: Date, default: null },
    supersededReason: { type: String, default: null, maxlength: 400 },

    assignedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
    note: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'attributions' },
);

/**
 * One live attribution per order.
 *
 * Partial on `supersededBy: null`, so superseded rows accumulate freely while
 * the database itself refuses to let one order be credited to two creators at
 * once — the failure mode that pays two people for one sale.
 */
attributionSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { supersededBy: null } },
);

attributionSchema.index({ brandId: 1, attributedAt: -1 });
attributionSchema.index({ campaignCreatorId: 1, supersededBy: 1 });
attributionSchema.index({ creatorId: 1, campaignId: 1, supersededBy: 1 });

export type AttributionDoc = InferSchemaType<typeof attributionSchema>;
export const AttributionModel: Model<AttributionDoc> = model<AttributionDoc>(
  'Attribution',
  attributionSchema,
);

/* ------------------------------------------------------------ conflicts */

/**
 * A code and a prior click pointing at different creators.
 *
 * Precedence already decided the order — this exists so the disagreement is
 * countable. One conflict is noise; forty on the same pair of creators is two
 * people sharing a code, and nobody finds that out from a rule that resolves
 * silently.
 */
const attributionConflictSchema = new Schema(
  {
    // Same reasoning as above: the unique index is declared below.
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    winningMethod: { type: String, required: true, enum: ATTRIBUTION_METHODS },
    winningCampaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true },
    losingMethod: { type: String, required: true, enum: ATTRIBUTION_METHODS },
    losingCampaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true },
    losingTrackingAssetId: { type: Schema.Types.ObjectId, ref: 'TrackingAsset', default: null },

    detectedAt: { type: Date, required: true },
    reviewedAt: { type: Date, default: null },
    reviewedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
    resolution: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: false, collection: 'attribution_conflicts' },
);

/** Re-running attribution must not pile up duplicates of the same disagreement. */
attributionConflictSchema.index({ orderId: 1 }, { unique: true });
attributionConflictSchema.index({ brandId: 1, reviewedAt: 1, detectedAt: -1 });

export type AttributionConflictDoc = InferSchemaType<typeof attributionConflictSchema>;
export const AttributionConflictModel: Model<AttributionConflictDoc> =
  model<AttributionConflictDoc>('AttributionConflict', attributionConflictSchema);
