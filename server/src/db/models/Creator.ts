import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { CONSENT_METHODS, CREATOR_STATUSES, PLATFORMS } from '@anton/shared';
import { followerSnapshotSchema } from './shared-subdocs.js';

const creatorHandleSchema = new Schema(
  {
    platform: { type: String, required: true, enum: PLATFORMS },
    handle: { type: String, required: true, trim: true, lowercase: true, maxlength: 60 },
    platformUserId: { type: String, default: null, maxlength: 64 },
    profileUrl: { type: String, default: null },
  },
  { _id: false },
);

const consentRecordSchema = new Schema(
  {
    grantedAt: { type: Date, required: true },
    scopeVersion: { type: String, required: true, maxlength: 32 },
    /** Pins the exact bytes of the consent text the creator saw. */
    documentSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    /** Salted hash. The raw IP is never written to disk. */
    ipHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    method: { type: String, required: true, enum: CONSENT_METHODS },
    withdrawnAt: { type: Date, default: null },
  },
  { _id: false },
);

const payoutDetailsSchema = new Schema(
  {
    method: { type: String, enum: ['bank_transfer', 'paypal', 'gift_only', null], default: null },
    /**
     * An opaque reference from a future payment provider. Raw bank details are
     * deliberately not modelled: Phase 1 has no payout rail and storing them
     * would create a liability with no corresponding capability.
     */
    accountRefToken: { type: String, default: null, maxlength: 128 },
    taxCountry: { type: String, default: null, maxlength: 2 },
    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

const creatorSchema = new Schema(
  {
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, default: null, trim: true, lowercase: true },
    handles: {
      type: [creatorHandleSchema],
      required: true,
      validate: {
        validator: (v: unknown[]) => v.length > 0,
        message: 'a creator needs at least one platform handle',
      },
    },
    /** Append-only series. See FollowerSnapshot in shared for why. */
    followerSnapshots: { type: [followerSnapshotSchema], default: [] },
    nicheTags: { type: [String], default: [], index: true },
    country: { type: String, default: null, maxlength: 2 },
    city: { type: String, default: null, maxlength: 80 },
    languages: { type: [String], default: [] },
    whatsappCommunityId: { type: String, default: null, maxlength: 64 },
    joinedAt: { type: Date, default: null },
    consent: { type: consentRecordSchema, default: null },
    status: { type: String, required: true, enum: CREATOR_STATUSES, default: 'invited', index: true },
    payoutDetails: { type: payoutDetailsSchema, default: () => ({}) },
    notes: { type: String, default: null, maxlength: 2000 },
  },
  { timestamps: true, collection: 'creators' },
);

/**
 * One handle belongs to one creator. Partial so that the index only covers
 * documents that actually have handles, and unique so a duplicate import
 * fails loudly rather than splitting a creator's history across two records.
 */
creatorSchema.index(
  { 'handles.platform': 1, 'handles.handle': 1 },
  { unique: true, partialFilterExpression: { 'handles.handle': { $exists: true } } },
);
creatorSchema.index({ status: 1, 'handles.platform': 1 });
creatorSchema.index({ displayName: 'text', nicheTags: 'text' });

export type CreatorDoc = InferSchemaType<typeof creatorSchema>;
export const CreatorModel: Model<CreatorDoc> = model<CreatorDoc>('Creator', creatorSchema);
