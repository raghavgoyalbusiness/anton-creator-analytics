import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import {
  CAMPAIGN_STATUSES,
  COMPENSATION_MODELS,
  PLATFORMS,
  POST_FORMATS,
} from '@anton/shared';
import { moneySchema } from './shared-subdocs.js';

const deliverableSpecItemSchema = new Schema(
  {
    format: { type: String, required: true, enum: POST_FORMATS },
    count: { type: Number, required: true, min: 1, max: 100 },
  },
  { _id: false },
);

const trackingLinkSchema = new Schema(
  {
    id: { type: String, required: true },
    label: { type: String, required: true, maxlength: 80 },
    destinationUrl: { type: String, required: true },
    utmSource: { type: String, required: true, maxlength: 60 },
    utmMedium: { type: String, required: true, maxlength: 60 },
    utmCampaign: { type: String, required: true, maxlength: 60 },
    utmContent: { type: String, default: null, maxlength: 60 },
    assignedCreatorId: { type: Schema.Types.ObjectId, ref: 'Creator', default: null },
    issuedAt: { type: Date, required: true },
  },
  { _id: false },
);

const discountCodeSchema = new Schema(
  {
    id: { type: String, required: true },
    code: { type: String, required: true, maxlength: 40 },
    assignedCreatorId: { type: Schema.Types.ObjectId, ref: 'Creator', default: null },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, default: null },
    /**
     * Redemptions and revenue are only ever a figure the brand reported to us.
     * null means "the brand has not told us", which the report must render as
     * exactly that. Nothing here is ever inferred from reach or engagement.
     */
    reportedRedemptions: { type: Number, default: null, min: 0 },
    reportedRevenue: { type: moneySchema, default: null },
    reportedAt: { type: Date, default: null },
    reportedBySource: { type: String, default: null, maxlength: 120 },
  },
  { _id: false },
);

/** The operator-supplied comparison figure. Never a measured result. */
const megaBenchmarkSchema = new Schema(
  {
    label: { type: String, required: true, maxlength: 160 },
    quotedFee: { type: moneySchema, required: true },
    quotedReach: { type: Number, required: true, min: 1 },
    /** Rendered verbatim beside the number in the brand report. */
    sourceNote: { type: String, required: true, maxlength: 400 },
    enteredAt: { type: Date, required: true },
    enteredByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
  },
  { _id: false },
);

const campaignSchema = new Schema(
  {
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 140 },
    brief: { type: String, default: '', maxlength: 8000 },
    objective: { type: String, default: '', maxlength: 400 },
    status: { type: String, required: true, enum: CAMPAIGN_STATUSES, default: 'draft', index: true },
    platforms: { type: [String], required: true, enum: PLATFORMS },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    deliverableSpec: { type: [deliverableSpecItemSchema], default: [] },
    compensationModel: { type: String, required: true, enum: COMPENSATION_MODELS },
    currency: { type: String, required: true, match: /^[A-Z]{3}$/ },
    budgetTotal: { type: moneySchema, required: true },
    defaultPerCreatorRate: { type: moneySchema, required: true },
    trackingLinks: { type: [trackingLinkSchema], default: [] },
    discountCodes: { type: [discountCodeSchema], default: [] },
    megaBenchmark: { type: megaBenchmarkSchema, default: null },
  },
  { timestamps: true, collection: 'campaigns' },
);

campaignSchema.index({ brandId: 1, name: 1 }, { unique: true });
campaignSchema.index({ status: 1, startDate: -1 });

campaignSchema.pre('validate', function validateDates(next) {
  if (this.endDate && this.startDate && this.endDate.getTime() <= this.startDate.getTime()) {
    next(new Error('endDate must be after startDate'));
    return;
  }
  // Currency consistency is enforced here rather than trusted: a mismatched
  // budget currency silently corrupts every cost figure in the brand report.
  if (this.budgetTotal && this.budgetTotal.currency !== this.currency) {
    next(new Error('budgetTotal currency must match the campaign currency'));
    return;
  }
  if (this.defaultPerCreatorRate && this.defaultPerCreatorRate.currency !== this.currency) {
    next(new Error('defaultPerCreatorRate currency must match the campaign currency'));
    return;
  }
  next();
});

export type CampaignDoc = InferSchemaType<typeof campaignSchema>;
export const CampaignModel: Model<CampaignDoc> = model<CampaignDoc>('Campaign', campaignSchema);
