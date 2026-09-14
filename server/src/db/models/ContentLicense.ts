import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import {
  PERMITTED_USES,
  licenceStatus,
  permits,
  type PermittedUse,
} from '@anton/shared';

/**
 * Content usage rights.
 *
 * A brand that boosts a creator's video as a paid ad without a licence is
 * exposed, and so is Anton for having handed them the post. This model makes
 * the grant explicit and per-campaign.
 *
 * The default is NO licence. Nothing here is implied by a creator joining a
 * campaign, and the absence of a ContentLicense row means the brand has organic
 * reshare rights only if the campaign brief separately says so — never by
 * default from this system's silence.
 */

/*
 * The vocabulary and the rules live in @anton/shared. Re-exported here so
 * existing imports keep working, but there is one definition, beside the logic
 * that interprets it.
 */
export { PERMITTED_USES, type PermittedUse };

const contentLicenseSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    brandId: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    /**
     * Which posts. An empty array means the licence covers every post the
     * creator makes on this campaign; a populated array narrows it to those.
     * Distinguished explicitly rather than by convention, because "all" and
     * "none recorded yet" must not look the same.
     */
    scope: { type: String, required: true, enum: ['all_campaign_posts', 'named_posts'], default: 'named_posts' },
    postIds: { type: [Schema.Types.ObjectId], ref: 'Post', default: [] },

    permittedUses: {
      type: [String],
      enum: PERMITTED_USES,
      default: [],
    },

    /** ISO 3166-1 alpha-2 codes, or the literal 'WORLDWIDE'. */
    territory: { type: [String], default: [] },

    startsAt: { type: Date, required: true },
    /** null = perpetual. Allowed, but the UI must make it unmissable. */
    endsAt: { type: Date, default: null },

    /** Name and likeness is a separate grant from the footage itself. */
    nameAndLikenessPermitted: { type: Boolean, required: true, default: false },
    /** Whether the brand may edit or recut the material. */
    modificationPermitted: { type: Boolean, required: true, default: false },
    /** Whether the brand may run it as an ad from the brand's own handle. */
    whitelistingPermitted: { type: Boolean, required: true, default: false },

    /** How the creator agreed, mirroring the consent record's structure. */
    grantedAt: { type: Date, default: null },
    grantMethod: { type: String, enum: ['web_form', 'whatsapp_message', 'contract', null], default: null },
    grantDocumentSha256: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
    grantIpHash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },

    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 400 },

    /** Fee paid specifically for these rights, separate from the post fee. */
    licenseFeeMinor: { type: Number, default: null, min: 0 },
    currency: { type: String, default: null, maxlength: 3 },

    notes: { type: String, default: null, maxlength: 2000 },

    /**
     * Who proposed these terms, and when the creator was asked.
     *
     * An ungranted row is a REQUEST, not a licence. Recording who drafted it
     * keeps "the brand wanted these rights" distinct from "the creator agreed
     * to them", which is the distinction the whole model exists to hold.
     */
    requestedByOperatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null },
    requestedAt: { type: Date, default: null },
    /** The exact wording the creator was shown, hashed, as with consent. */
    termsSha256: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  },
  { timestamps: true, collection: 'content_licenses' },
);

contentLicenseSchema.index({ campaignId: 1, creatorId: 1 }, { unique: true });
contentLicenseSchema.index({ brandId: 1, endsAt: 1 });

contentLicenseSchema.pre('validate', function validateGrant(next) {
  if (this.scope === 'named_posts' && this.postIds.length === 0 && this.grantedAt != null) {
    next(new Error('a granted named-posts licence must name at least one post'));
    return;
  }
  if (this.grantedAt != null && this.permittedUses.length === 0) {
    next(new Error('a granted licence must permit at least one use, otherwise record no licence at all'));
    return;
  }
  if (this.endsAt != null && this.endsAt.getTime() <= this.startsAt.getTime()) {
    next(new Error('endsAt must be after startsAt'));
    return;
  }
  next();
});

export type ContentLicenseDoc = InferSchemaType<typeof contentLicenseSchema>;
export const ContentLicenseModel: Model<ContentLicenseDoc> = model<ContentLicenseDoc>(
  'ContentLicense',
  contentLicenseSchema,
);

/**
 * Adapts a stored document to the shape the shared rules expect.
 *
 * A thin shim on purpose: the decision about what a brand may do is not
 * allowed to live in two places, and the version that matters is the pure one
 * that can be replayed from a fixture in a dispute.
 */
export function toLicenceLike(doc: ContentLicenseDoc | null): Parameters<typeof licenceStatus>[0] {
  if (!doc) return null;
  return {
    permittedUses: doc.permittedUses,
    territory: doc.territory,
    grantedAt: doc.grantedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    startsAt: doc.startsAt,
    endsAt: doc.endsAt ?? null,
    nameAndLikenessPermitted: doc.nameAndLikenessPermitted,
    modificationPermitted: doc.modificationPermitted,
    whitelistingPermitted: doc.whitelistingPermitted,
  };
}

/** Is a use permitted right now? Absence of a licence is always "no". */
export function licencePermits(
  licence: ContentLicenseDoc | null,
  use: PermittedUse,
  at: Date,
): boolean {
  return permits(toLicenceLike(licence), use, at);
}
