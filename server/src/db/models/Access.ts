import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const operatorSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, maxlength: 120 },
    /** argon2id. Never a raw or reversibly-encoded password. */
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ['owner', 'operator'], default: 'operator' },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'operators' },
);
operatorSchema.index({ email: 1 }, { unique: true });

/**
 * A creator's keyless entry point.
 *
 * Only the SHA-256 of the token is stored. The raw token exists exactly once,
 * in the response to the bulk-invite call, for pasting into WhatsApp. A dump of
 * this collection therefore does not yield a single working link.
 */
const magicLinkSchema = new Schema(
  {
    tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    firstOpenedAt: { type: Date, default: null },
    lastOpenedAt: { type: Date, default: null },
    openCount: { type: Number, default: 0, min: 0 },
    consentCapturedAt: { type: Date, default: null },
    firstSubmissionAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    issuedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'magic_links' },
);
magicLinkSchema.index({ tokenHash: 1 }, { unique: true });
/**
 * Funnel query for the bulk-invite tracker: issued -> opened -> consented ->
 * submitted, per campaign.
 */
magicLinkSchema.index({ campaignId: 1, firstOpenedAt: 1, consentCapturedAt: 1 });

/** The brand-facing read-only report URL. Unguessable token, optional expiry. */
const shareLinkSchema = new Schema(
  {
    tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    label: { type: String, required: true, maxlength: 120 },
    issuedAt: { type: Date, required: true },
    /** null = no expiry. Deliberately allowed; the operator chooses. */
    expiresAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0, min: 0 },
    lastViewedAt: { type: Date, default: null },
    issuedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'share_links' },
);
shareLinkSchema.index({ tokenHash: 1 }, { unique: true });

export type OperatorDoc = InferSchemaType<typeof operatorSchema>;
export type MagicLinkDoc = InferSchemaType<typeof magicLinkSchema>;
export type ShareLinkDoc = InferSchemaType<typeof shareLinkSchema>;

export const OperatorModel: Model<OperatorDoc> = model<OperatorDoc>('Operator', operatorSchema);
export const MagicLinkModel: Model<MagicLinkDoc> = model<MagicLinkDoc>('MagicLink', magicLinkSchema);
export const ShareLinkModel: Model<ShareLinkDoc> = model<ShareLinkDoc>('ShareLink', shareLinkSchema);
