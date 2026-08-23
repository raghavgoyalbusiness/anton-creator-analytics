import type { IsoCountryCode, LanguageCode, Platform } from './common.js';

export type CreatorStatus = 'invited' | 'active' | 'paused' | 'removed';
export const CREATOR_STATUSES = [
  'invited',
  'active',
  'paused',
  'removed',
] as const satisfies readonly CreatorStatus[];

export type ConsentMethod = 'whatsapp_message' | 'web_form' | 'oauth';
export const CONSENT_METHODS = [
  'whatsapp_message',
  'web_form',
  'oauth',
] as const satisfies readonly ConsentMethod[];

export interface CreatorHandle {
  readonly platform: Platform;
  /** Stored without a leading '@', lowercased. */
  readonly handle: string;
  /** Platform-native user id, when we learn it (OAuth, or manual entry). */
  readonly platformUserId: string | null;
  readonly profileUrl: string | null;
}

/**
 * DEVIATION FROM BRIEF, deliberate.
 * The brief asks for "follower count with capturedAt". This is an append-only
 * series instead of one pair, because the `reach > followers x 50` plausibility
 * rule has to compare a post's reach against the follower count AS IT WAS when
 * the post went live — not against today's. A single overwritten pair silently
 * re-scores historical posts every time we refresh a creator's followers.
 */
export interface FollowerSnapshot {
  readonly platform: Platform;
  readonly count: number;
  readonly capturedAt: Date;
  /** How we learned it. Screenshot-derived counts are lower trust. */
  readonly source: 'manual' | 'screenshot' | 'oauth';
}

/**
 * The consent record. `scopeVersion` names the CONSENT.md revision the creator
 * agreed to; `documentSha256` pins the exact bytes of that revision so a later
 * edit to the document cannot retroactively change what someone consented to.
 */
export interface ConsentRecord {
  readonly grantedAt: Date;
  readonly scopeVersion: string;
  readonly documentSha256: string;
  /** Salted SHA-256 of the source IP. The raw IP is never stored. */
  readonly ipHash: string;
  readonly method: ConsentMethod;
  readonly withdrawnAt: Date | null;
}

/** Structured, deliberately unimplemented. No payout rails in Phase 1. */
export interface PayoutDetails {
  readonly method: 'bank_transfer' | 'paypal' | 'gift_only' | null;
  readonly accountRefToken: string | null; // opaque token from a future PSP; never raw bank details
  readonly taxCountry: IsoCountryCode | null;
  readonly verifiedAt: Date | null;
}

export interface Creator {
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly handles: readonly CreatorHandle[];
  readonly followerSnapshots: readonly FollowerSnapshot[];
  readonly nicheTags: readonly string[];
  readonly country: IsoCountryCode | null;
  readonly city: string | null;
  readonly languages: readonly LanguageCode[];
  readonly whatsappCommunityId: string | null;
  readonly joinedAt: Date | null;
  readonly consent: ConsentRecord | null;
  readonly status: CreatorStatus;
  readonly payoutDetails: PayoutDetails;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Follower count for a platform as at a point in time. Returns the most recent
 * snapshot at or before `asOf`; falls back to the earliest snapshot we hold if
 * every capture postdates the moment asked about (a post logged before we first
 * measured the creator), and null if we hold none at all.
 *
 * Callers must treat null as "cannot evaluate", never as zero.
 */
export function followerCountAsOf(
  snapshots: readonly FollowerSnapshot[],
  platform: Platform,
  asOf: Date,
): FollowerSnapshot | null {
  const forPlatform = snapshots
    .filter((s) => s.platform === platform)
    .slice()
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  if (forPlatform.length === 0) return null;

  let best: FollowerSnapshot | null = null;
  for (const snap of forPlatform) {
    if (snap.capturedAt.getTime() <= asOf.getTime()) best = snap;
    else break;
  }
  return best ?? forPlatform[0] ?? null;
}
