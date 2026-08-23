import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Sessions, for both creators and operators.
 *
 * A magic-link token is short-lived and single-use; exchanging it mints one of
 * these and sets an httpOnly cookie. The token itself is never a long-lived
 * credential, so a link forwarded into a group chat is either already spent or
 * about to expire.
 *
 * Only the SHA-256 of the session id is stored, same reasoning as the tokens:
 * a database dump yields no usable session.
 */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    subjectKind: { type: String, required: true, enum: ['creator', 'operator'] },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', default: null, index: true },
    operatorId: { type: Schema.Types.ObjectId, ref: 'Operator', default: null, index: true },

    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 120 },

    /** Recorded for every session creation, per the addendum. Never the raw IP. */
    ipHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    userAgent: { type: String, default: '', maxlength: 400 },

    /** Which magic link minted this, so revoking a link can revoke its sessions. */
    viaMagicLinkId: { type: Schema.Types.ObjectId, ref: 'MagicLink', default: null },

    /**
     * Operator only. Bulk export and bulk deletion require a fresh password
     * check; this stamps when that last happened.
     */
    lastReauthAt: { type: Date, default: null },
  },
  { timestamps: false, collection: 'sessions' },
);

sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ creatorId: 1, revokedAt: 1 });
sessionSchema.index({ operatorId: 1, revokedAt: 1 });
/** Mongo reaps expired sessions itself; no cron needed for this one. */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = InferSchemaType<typeof sessionSchema>;
export const SessionModel: Model<SessionDoc> = model<SessionDoc>('Session', sessionSchema);

/**
 * Append-only audit log.
 *
 * Every operator action that reads, changes, exports or shares creator data
 * writes a row. No update or delete path exists in the application: the model
 * exposes only `record()`, and the collection has no route that mutates it.
 */
const auditLogSchema = new Schema(
  {
    at: { type: Date, required: true, index: true },
    actorKind: { type: String, required: true, enum: ['operator', 'creator', 'system'] },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorLabel: { type: String, required: true, maxlength: 160 },
    action: { type: String, required: true, maxlength: 80, index: true },
    /** What was acted on: collection name plus id, when there is one. */
    subjectKind: { type: String, default: null, maxlength: 40 },
    subjectId: { type: Schema.Types.ObjectId, default: null, index: true },
    /** Free-form detail. Must never contain a raw IP, token, or password. */
    detail: { type: Schema.Types.Mixed, default: {} },
    ipHash: { type: String, default: null, match: /^[a-f0-9]{64}$/ },
  },
  { timestamps: false, collection: 'audit_log' },
);

auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ subjectId: 1, at: -1 });

export type AuditLogDoc = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel: Model<AuditLogDoc> = model<AuditLogDoc>('AuditLog', auditLogSchema);
