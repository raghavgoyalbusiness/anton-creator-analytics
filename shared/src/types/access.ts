/**
 * Collections the brief does not enumerate but which the three surfaces need.
 * Operator = password auth. Creator = magic link, no password. Brand = share
 * token, no account.
 */

export interface Operator {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly role: 'owner' | 'operator';
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A creator's keyless entry point. The raw token is shown once, at generation,
 * for pasting into WhatsApp; only its SHA-256 is stored, so a database leak
 * does not hand over working links.
 */
export interface MagicLink {
  readonly id: string;
  readonly tokenHash: string;
  readonly creatorId: string;
  /** null = a general access link, not scoped to one campaign. */
  readonly campaignId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly firstOpenedAt: Date | null;
  readonly lastOpenedAt: Date | null;
  readonly openCount: number;
  readonly consentCapturedAt: Date | null;
  readonly firstSubmissionAt: Date | null;
  readonly revokedAt: Date | null;
  readonly issuedByOperatorId: string;
  readonly createdAt: Date;
}

/** The brand-facing read-only report URL. */
export interface ShareLink {
  readonly id: string;
  readonly tokenHash: string;
  readonly campaignId: string;
  readonly label: string;
  readonly issuedAt: Date;
  /** null = never expires. */
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly viewCount: number;
  readonly lastViewedAt: Date | null;
  readonly issuedByOperatorId: string;
  readonly createdAt: Date;
}

export function isLinkUsable(
  link: Pick<MagicLink | ShareLink, 'expiresAt' | 'revokedAt'>,
  now: Date,
): boolean {
  if (link.revokedAt !== null) return false;
  if (link.expiresAt !== null && link.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
