import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import {
  BPS_PER_UNIT,
  RATE_BASES,
  TRACKING_ASSET_STATUSES,
  TRACKING_ASSET_TYPES,
  normaliseTypedCode,
} from '@anton/shared';

/**
 * A discount code or tracked link issued to one creator on one campaign.
 *
 * Replaces the arrays that were embedded on Campaign. Embedded subdocuments
 * cannot carry a unique index, so "this code is not already in use for this
 * brand" was previously unenforceable at the database — and a reused code
 * attributes one creator's sales to another.
 */
const trackingAssetSchema = new Schema(
  {
    campaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    type: { type: String, required: true, enum: TRACKING_ASSET_TYPES },
    value: { type: String, required: true, maxlength: 2048 },

    /**
     * The code as it matches, with confusable characters folded.
     *
     * Stored alongside the display value so an order export can be joined
     * against it with an index rather than by scanning every asset and calling
     * codesMatch() in application code.
     */
    matchKey: { type: String, required: true, index: true },

    shortCode: { type: String, default: null },
    destinationUrl: { type: String, default: null, maxlength: 2048 },

    issuedAt: { type: Date, required: true },
    activeFrom: { type: Date, required: true },
    /** null = no end date. The campaign's own end date still applies. */
    activeUntil: { type: Date, default: null },
    status: { type: String, required: true, enum: TRACKING_ASSET_STATUSES, default: 'active' },

    /**
     * Commission terms captured at issue.
     *
     * Copied rather than referenced so that changing a campaign's default rate
     * next month does not silently re-price commission already earned. The
     * creator agreed to the rate that was on their asset when they posted.
     */
    commissionRateBps: {
      type: Number,
      required: true,
      min: 0,
      max: BPS_PER_UNIT,
      validate: {
        validator: Number.isInteger,
        message: 'rates are whole basis points; 12.5% is 1250',
      },
    },
    commissionRateBasis: { type: String, required: true, enum: RATE_BASES },

    issuedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 400 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'tracking_assets' },
);

/**
 * A code is unique within a brand, not globally.
 *
 * Two brands may both run AMARA10 without ambiguity — the order carries which
 * brand it belongs to. Scoping any tighter than the brand would let the same
 * code mean two creators inside one brand's checkout, which is the collision
 * that actually costs someone money.
 */
trackingAssetSchema.index(
  { brandId: 1, matchKey: 1 },
  { unique: true, partialFilterExpression: { type: 'discount_code' } },
);

/** Short codes resolve globally, so they must be globally unique. */
trackingAssetSchema.index(
  { shortCode: 1 },
  { unique: true, partialFilterExpression: { shortCode: { $type: 'string' } } },
);

trackingAssetSchema.index({ campaignId: 1, status: 1 });
trackingAssetSchema.index({ campaignCreatorId: 1, type: 1 });

trackingAssetSchema.pre('validate', function normaliseAndCheck(next) {
  if (this.type === 'discount_code') {
    this.matchKey = normaliseTypedCode(this.value);
    if (this.shortCode) {
      next(new Error('a discount code does not carry a short code'));
      return;
    }
  } else {
    if (!this.shortCode) {
      next(new Error('a tracked link needs a short code'));
      return;
    }
    if (!this.destinationUrl) {
      next(new Error('a tracked link needs a destination URL'));
      return;
    }
    // Links match on their short code, not on a typed string.
    this.matchKey = this.shortCode;
  }
  next();
});

/** Is this asset usable for attribution at a given moment? */
export function assetIsActive(
  asset: Pick<TrackingAssetDoc, 'status' | 'activeFrom' | 'activeUntil' | 'revokedAt'>,
  at: Date,
): boolean {
  if (asset.status !== 'active') return false;
  if (asset.revokedAt) return false;
  if (asset.activeFrom.getTime() > at.getTime()) return false;
  if (asset.activeUntil && asset.activeUntil.getTime() < at.getTime()) return false;
  return true;
}

export type TrackingAssetDoc = InferSchemaType<typeof trackingAssetSchema>;
export const TrackingAssetModel: Model<TrackingAssetDoc> = model<TrackingAssetDoc>(
  'TrackingAsset',
  trackingAssetSchema,
);

/* --------------------------------------------------------------- clicks */

/**
 * A click on a tracked link.
 *
 * The visitor identifier is a salted hash with a short rotation, not a durable
 * cookie: enough to join a click to an order inside the attribution window,
 * and useless for following anyone beyond it.
 */
const linkClickSchema = new Schema(
  {
    trackingAssetId: { type: Schema.Types.ObjectId, ref: 'TrackingAsset', required: true, index: true },
    campaignCreatorId: { type: Schema.Types.ObjectId, ref: 'CampaignCreator', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    clickedAt: { type: Date, required: true },
    visitorHash: { type: String, required: true, index: true, match: /^[a-f0-9]{64}$/ },
    /** Coarse only — "Chrome on Android", never a fingerprint. */
    userAgentFamily: { type: String, default: null, maxlength: 60 },
    referrerHost: { type: String, default: null, maxlength: 120 },
  },
  { timestamps: false, collection: 'link_clicks' },
);

/** The attribution lookup: this visitor, this brand, most recent click first. */
linkClickSchema.index({ brandId: 1, visitorHash: 1, clickedAt: -1 });

/**
 * Clicks expire on their own.
 *
 * A click is only ever useful inside the attribution window; keeping it beyond
 * that is retaining a behavioural record of a member of the public for no
 * purpose. 90 days is comfortably past the longest window the product allows.
 */
linkClickSchema.index({ clickedAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type LinkClickDoc = InferSchemaType<typeof linkClickSchema>;
export const LinkClickModel: Model<LinkClickDoc> = model<LinkClickDoc>('LinkClick', linkClickSchema);
