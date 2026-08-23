import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

const operatorSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    displayName: { type: String, required: true, maxlength: 120 },
    /** Argon2id. Never selected by default, so it cannot leak via a stray find(). */
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, required: true, enum: ['owner', 'operator'], default: 'operator' },
    lastLoginAt: { type: Date, default: null },

    /**
     * TOTP is required, not optional: this account can read every creator's
     * private analytics. `totpEnrolledAt` null means a secret exists but the
     * operator has not yet proved they can generate a code, and cannot log in.
     */
    totpSecret: { type: String, default: null, select: false },
    totpEnrolledAt: { type: Date, default: null },
    /** Single-use recovery codes, Argon2id-hashed. Never shown twice. */
    recoveryCodeHashes: { type: [String], default: [], select: false },
    failedLoginCount: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date, default: null },
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
    /**
     * Single-use. Set the moment the token is exchanged for a session; a second
     * exchange with the same token is refused even before expiry, so a link
     * forwarded into a group chat is spent by whoever tapped it first.
     */
    usedAt: { type: Date, default: null },
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
    /**
     * Mandatory. An unguessable URL is obscurity, not access control, so a
     * share link that never dies is a permanent unauthenticated read of a
     * roster. Defaults to 30 days at the route.
     */
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },

    /**
     * Display toggles, each defaulting to the safer setting.
     * Compensation off: a brand does not need per-creator rates to read a
     * performance report, and rates are commercially sensitive.
     */
    showCompensation: { type: Boolean, required: true, default: false },
    /**
     * Handles visible, because attribution is the point — but a brand that
     * might poach the roster is a real risk, so this can be switched to niche
     * plus follower band per link.
     */
    showCreatorHandles: { type: Boolean, required: true, default: true },

    /** Optional email gate. Forced on for any link showing compensation. */
    requireEmailGate: { type: Boolean, required: true, default: false },
    /** Emails that have completed the one-time code challenge on this link. */
    verifiedViewerEmails: { type: [String], default: [] },

    viewCount: { type: Number, default: 0, min: 0 },
    lastViewedAt: { type: Date, default: null },
    /** Per-view log, capped at the most recent 500 entries by the route. */
    views: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            ipHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
            userAgent: { type: String, default: '', maxlength: 400 },
            viewerEmail: { type: String, default: null, maxlength: 200 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
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

/**
 * A magic link is usable only if unrevoked, unexpired AND unspent.
 * Returns the reason rather than a bare boolean so the route can tell a creator
 * whether to ask for a new link or whether someone else already used theirs.
 */
export function isMagicLinkUsable(
  link: { expiresAt: Date; revokedAt: Date | null; usedAt: Date | null },
  now: Date,
): { ok: true } | { ok: false; reason: 'revoked' | 'expired' | 'already_used' } {
  if (link.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (link.usedAt !== null) return { ok: false, reason: 'already_used' };
  if (link.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true };
}
