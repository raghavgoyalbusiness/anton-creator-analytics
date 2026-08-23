import type { Types } from 'mongoose';
import { AuditLogModel } from '../db/models/index.js';

/**
 * Append-only audit trail.
 *
 * Every operator action that reads, changes, exports or shares creator data
 * goes through here. There is deliberately no update or delete helper: the only
 * write path in the codebase is `recordAudit`.
 *
 * A failure to write an audit row must not fail the action it describes — that
 * would make the log a single point of failure for the whole product — but it
 * must be loud, because a silent gap in an audit trail is worse than no trail.
 */
export interface AuditEntry {
  readonly actorKind: 'operator' | 'creator' | 'system';
  readonly actorId?: Types.ObjectId | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly subjectKind?: string | null;
  readonly subjectId?: Types.ObjectId | null;
  readonly detail?: Record<string, unknown>;
  /** Already hashed. Never pass a raw IP into this. */
  readonly ipHash?: string | null;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      at: new Date(),
      actorKind: entry.actorKind,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      subjectKind: entry.subjectKind ?? null,
      subjectId: entry.subjectId ?? null,
      detail: entry.detail ?? {},
      ipHash: entry.ipHash ?? null,
    });
  } catch (err: unknown) {
    console.error('[audit] FAILED TO RECORD', entry.action, err);
  }
}

/** Actions worth a constant, so a typo cannot fragment the log. */
export const AUDIT = {
  creatorSessionCreated: 'creator.session.created',
  creatorSessionsRevoked: 'creator.sessions.revoked',
  creatorConsentGiven: 'creator.consent.given',
  creatorConsentWithdrawn: 'creator.consent.withdrawn',
  creatorExported: 'creator.data.exported',
  creatorDeleted: 'creator.data.deleted',
  postSubmitted: 'post.submitted',
  postExtracted: 'post.extracted',
  postVerified: 'post.verified',
  postRejected: 'post.rejected',
  postOverridden: 'post.metric.overridden',
  operatorLogin: 'operator.login',
  operatorLoginFailed: 'operator.login.failed',
  operatorReauth: 'operator.reauth',
  operatorViewedCreator: 'operator.creator.viewed',
  operatorBulkExport: 'operator.bulk.export',
  operatorBulkDelete: 'operator.bulk.delete',
  magicLinksIssued: 'magic_links.issued',
  magicLinksRevoked: 'magic_links.revoked',
  shareLinkCreated: 'share_link.created',
  shareLinkRevoked: 'share_link.revoked',
  shareLinkViewed: 'share_link.viewed',
  extractionSpendCeiling: 'extraction.spend_ceiling_reached',
  promptInjectionDetected: 'extraction.instruction_text_detected',
  retentionPurge: 'retention.purge',
} as const;
