import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { CAMPAIGN_CREATOR_STATUSES } from '@anton/shared';
import { moneySchema } from './shared-subdocs.js';

const statusTransitionSchema = new Schema(
  {
    from: { type: String, enum: [...CAMPAIGN_CREATOR_STATUSES, null], default: null },
    to: { type: String, required: true, enum: CAMPAIGN_CREATOR_STATUSES },
    at: { type: Date, required: true },
    /** Operator ObjectId as a string, or the literal 'creator'. */
    by: { type: String, required: true },
    note: { type: String, default: null, maxlength: 500 },
  },
  { _id: false },
);

const campaignCreatorSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    status: {
      type: String,
      required: true,
      enum: CAMPAIGN_CREATOR_STATUSES,
      default: 'invited',
      index: true,
    },
    agreedRate: { type: moneySchema, default: null },
    productShipped: { type: Boolean, default: false },
    shippedAt: { type: Date, default: null },
    trackingNumber: { type: String, default: null, maxlength: 80 },
    assignedDiscountCodeId: { type: String, default: null, maxlength: 64 },
    assignedTrackingLinkId: { type: String, default: null, maxlength: 64 },
    invitedAt: { type: Date, default: null },
    respondedAt: { type: Date, default: null },
    firstPostedAt: { type: Date, default: null },
    lastSubmissionAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    /** Append-only. Status is never edited without writing a transition here. */
    history: { type: [statusTransitionSchema], default: [] },
  },
  { timestamps: true, collection: 'campaign_creators' },
);

/** A creator appears at most once per campaign. */
campaignCreatorSchema.index({ campaignId: 1, creatorId: 1 }, { unique: true });
/** Drives the nudge list: who is stuck in which stage, and since when. */
campaignCreatorSchema.index({ campaignId: 1, status: 1, respondedAt: 1 });

export type CampaignCreatorDoc = InferSchemaType<typeof campaignCreatorSchema>;
export const CampaignCreatorModel: Model<CampaignCreatorDoc> = model<CampaignCreatorDoc>(
  'CampaignCreator',
  campaignCreatorSchema,
);
