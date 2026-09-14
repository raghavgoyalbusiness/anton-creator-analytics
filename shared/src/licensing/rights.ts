/**
 * What a brand may actually do with a creator's post.
 *
 * The default is no. Nothing here is implied by a creator joining a campaign,
 * by a post being submitted, or by this system's silence — a brand that boosts
 * a creator's video as a paid ad without a licence is exposed, and so is Anton
 * for having handed them the post.
 *
 * Every function below therefore answers "no" when it does not have a positive,
 * dated, unexpired, unrevoked grant covering exactly the use being asked about.
 * Pure, so the answer can be reproduced from a fixture in a dispute.
 */

export const PERMITTED_USES = [
  'organic_reshare',
  'paid_amplification',
  'website',
  'print',
  'email_marketing',
  'in_store_display',
] as const;
export type PermittedUse = (typeof PERMITTED_USES)[number];

export const USE_LABELS: Readonly<Record<PermittedUse, string>> = Object.freeze({
  organic_reshare: 'Reshare on the brand’s own feed',
  paid_amplification: 'Run as a paid ad',
  website: 'Use on the brand’s website',
  print: 'Use in print',
  email_marketing: 'Use in marketing emails',
  in_store_display: 'Show in store',
});

/**
 * What the creator is actually agreeing to, in the words they will read.
 *
 * Kept beside the machine-readable key so the two cannot drift. A consent
 * screen that describes a right differently from the record it writes is worse
 * than no consent screen.
 */
export const USE_EXPLANATIONS: Readonly<Record<PermittedUse, string>> = Object.freeze({
  organic_reshare:
    'The brand can repost your video on their own account, unpaid, crediting you.',
  paid_amplification:
    'The brand can put money behind your video so it reaches people who do not follow either of you. It will be labelled as an ad.',
  website: 'The brand can put your video or photos on their own website.',
  print: 'The brand can use a still from your post in printed material.',
  email_marketing: 'The brand can include your post in emails to their customers.',
  in_store_display: 'The brand can play your video on screens in their shops.',
});

export const AD_PLATFORMS = ['tiktok_spark', 'meta_partnership'] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

export const AD_PLATFORM_LABELS: Readonly<Record<AdPlatform, string>> = Object.freeze({
  tiktok_spark: 'TikTok Spark Ads',
  meta_partnership: 'Meta partnership ad',
});

export const WORLDWIDE = 'WORLDWIDE';

export interface LicenceLike {
  readonly permittedUses: readonly string[];
  readonly territory: readonly string[];
  readonly grantedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
  readonly nameAndLikenessPermitted: boolean;
  readonly modificationPermitted: boolean;
  readonly whitelistingPermitted: boolean;
}

export type LicenceState =
  | 'none'
  | 'awaiting_creator'
  | 'active'
  | 'not_yet_started'
  | 'expired'
  | 'revoked';

export interface LicenceStatus {
  readonly state: LicenceState;
  /** A sentence the brand and the creator both read. */
  readonly summary: string;
  readonly usableNow: boolean;
  /** Days until expiry. Null for perpetual, or when not currently active. */
  readonly daysUntilExpiry: number | null;
  readonly isPerpetual: boolean;
}

const DAY_MS = 86_400_000;

export function licenceStatus(licence: LicenceLike | null, at: Date): LicenceStatus {
  if (!licence) {
    return {
      state: 'none',
      summary:
        'No licence on record. The brand may not reshare, boost, or otherwise reuse this creator’s post.',
      usableNow: false,
      daysUntilExpiry: null,
      isPerpetual: false,
    };
  }

  const isPerpetual = licence.endsAt === null;

  if (licence.revokedAt !== null) {
    return {
      state: 'revoked',
      summary: 'The creator withdrew this licence. The brand must stop using the material.',
      usableNow: false,
      daysUntilExpiry: null,
      isPerpetual,
    };
  }

  /**
   * An ungranted row is a REQUEST, not a licence.
   *
   * The operator can draft the terms; nothing is permitted until the creator
   * has actually agreed to them, so the two states must never collapse.
   */
  if (licence.grantedAt === null) {
    return {
      state: 'awaiting_creator',
      summary:
        'These terms have been proposed but the creator has not agreed to them yet. Nothing is permitted until they do.',
      usableNow: false,
      daysUntilExpiry: null,
      isPerpetual,
    };
  }

  if (at.getTime() < licence.startsAt.getTime()) {
    return {
      state: 'not_yet_started',
      summary: `Agreed, but the licence does not begin until ${licence.startsAt.toISOString().slice(0, 10)}.`,
      usableNow: false,
      daysUntilExpiry: null,
      isPerpetual,
    };
  }

  if (licence.endsAt !== null && at.getTime() > licence.endsAt.getTime()) {
    return {
      state: 'expired',
      summary: `This licence ended on ${licence.endsAt.toISOString().slice(0, 10)}. The brand must stop using the material.`,
      usableNow: false,
      daysUntilExpiry: null,
      isPerpetual: false,
    };
  }

  const daysUntilExpiry =
    licence.endsAt === null
      ? null
      : Math.ceil((licence.endsAt.getTime() - at.getTime()) / DAY_MS);

  return {
    state: 'active',
    summary: isPerpetual
      ? 'Agreed, with no end date. The brand may use this material indefinitely unless the creator withdraws.'
      : `Agreed, running until ${licence.endsAt?.toISOString().slice(0, 10)}.`,
    usableNow: true,
    daysUntilExpiry,
    isPerpetual,
  };
}

/** The single question every caller should be asking. Absence is always "no". */
export function permits(licence: LicenceLike | null, use: PermittedUse, at: Date): boolean {
  if (!licenceStatus(licence, at).usableNow) return false;
  return licence?.permittedUses.includes(use) ?? false;
}

/** Territory check. An empty territory list grants nowhere, not everywhere. */
export function permittedInTerritory(licence: LicenceLike | null, countryCode: string): boolean {
  if (!licence) return false;
  if (licence.territory.includes(WORLDWIDE)) return true;
  return licence.territory.includes(countryCode.toUpperCase());
}

/* ------------------------------------------------------- ad authorisation */

export interface AdAuthorisationLike {
  readonly platform: string;
  readonly code: string;
  readonly providedAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export type AdReadinessBlocker =
  | 'no_licence'
  | 'licence_does_not_permit_ads'
  | 'no_ad_code'
  | 'ad_code_expired'
  | 'ad_code_revoked';

export interface AdReadiness {
  readonly ready: boolean;
  readonly blockers: readonly AdReadinessBlocker[];
  /** What to do about it, in words an account manager can act on. */
  readonly whatIsNeeded: string | null;
  readonly code: string | null;
  readonly codeExpiresAt: Date | null;
  readonly daysUntilCodeExpiry: number | null;
}

/**
 * Whether a post can actually be run as an ad right now.
 *
 * Two separate things have to be true and they fail independently, which is
 * exactly why they are reported separately. A licence permitting paid
 * amplification is the creator's legal permission; a Spark or partnership code
 * is the platform's technical permission. Having one and not the other is the
 * normal state of affairs a week before a campaign goes live, and an
 * account manager needs to know which one is missing.
 */
export function adReadiness(params: {
  licence: LicenceLike | null;
  authorisation: AdAuthorisationLike | null;
  at: Date;
}): AdReadiness {
  const blockers: AdReadinessBlocker[] = [];

  const status = licenceStatus(params.licence, params.at);
  if (!status.usableNow) {
    blockers.push('no_licence');
  } else if (!params.licence?.permittedUses.includes('paid_amplification')) {
    blockers.push('licence_does_not_permit_ads');
  }

  const auth = params.authorisation;
  if (!auth) {
    blockers.push('no_ad_code');
  } else if (auth.revokedAt !== null) {
    blockers.push('ad_code_revoked');
  } else if (auth.expiresAt !== null && params.at.getTime() > auth.expiresAt.getTime()) {
    blockers.push('ad_code_expired');
  }

  const daysUntilCodeExpiry =
    auth?.expiresAt != null
      ? Math.ceil((auth.expiresAt.getTime() - params.at.getTime()) / DAY_MS)
      : null;

  return {
    ready: blockers.length === 0,
    blockers,
    whatIsNeeded: blockers.length === 0 ? null : describeBlockers(blockers),
    code: blockers.length === 0 ? (auth?.code ?? null) : null,
    codeExpiresAt: auth?.expiresAt ?? null,
    daysUntilCodeExpiry,
  };
}

function describeBlockers(blockers: readonly AdReadinessBlocker[]): string {
  const parts: string[] = [];
  if (blockers.includes('no_licence')) {
    parts.push('the creator has not granted a licence that is in force');
  }
  if (blockers.includes('licence_does_not_permit_ads')) {
    parts.push('the licence on record does not cover paid amplification');
  }
  if (blockers.includes('no_ad_code')) {
    parts.push('the creator has not supplied an ad authorisation code from the platform');
  }
  if (blockers.includes('ad_code_expired')) {
    parts.push('the ad authorisation code has expired and the creator needs to issue a new one');
  }
  if (blockers.includes('ad_code_revoked')) {
    parts.push('the ad authorisation code was withdrawn');
  }
  return `Cannot run as an ad: ${parts.join('; ')}.`;
}

/**
 * Spark codes are short-lived and the expiry is the thing that bites.
 *
 * A campaign that discovers its codes expired the morning it goes live has
 * lost the window, so this exists to be checked on a schedule rather than at
 * the moment of use.
 */
export function needsAttentionSoon(
  params: {
    licence: LicenceLike | null;
    authorisation: AdAuthorisationLike | null;
  },
  at: Date,
  withinDays = 14,
): { urgent: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const status = licenceStatus(params.licence, at);

  if (status.state === 'awaiting_creator') {
    reasons.push('the creator has not yet agreed to the proposed licence terms');
  }
  if (status.daysUntilExpiry !== null && status.daysUntilExpiry <= withinDays) {
    reasons.push(`the licence expires in ${status.daysUntilExpiry} days`);
  }

  const auth = params.authorisation;
  if (auth && auth.revokedAt === null && auth.expiresAt !== null) {
    const days = Math.ceil((auth.expiresAt.getTime() - at.getTime()) / DAY_MS);
    if (days <= withinDays) {
      reasons.push(
        days < 0
          ? `the ad authorisation code expired ${Math.abs(days)} days ago`
          : `the ad authorisation code expires in ${days} days`,
      );
    }
  }

  return { urgent: reasons.length > 0, reasons };
}

/**
 * Validates a platform authorisation code's shape.
 *
 * Deliberately loose on format and strict on everything else. TikTok and Meta
 * both change their code formats without notice, so rejecting an otherwise
 * valid code because a regex is a year out of date would block real work — but
 * a code with whitespace or control characters in it is a paste accident, and
 * silently storing it means an ad that does not run on the day.
 */
export function normaliseAdCode(raw: string): { ok: true; code: string } | { ok: false; reason: string } {
  const code = raw.trim();
  if (code.length === 0) return { ok: false, reason: 'the code is empty' };
  if (code.length > 200) return { ok: false, reason: 'that is too long to be an authorisation code' };
  if (/\s/.test(code)) {
    return {
      ok: false,
      reason: 'the code contains a space — check you copied only the code itself',
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(code)) {
    return { ok: false, reason: 'the code contains characters that should not be there' };
  }
  return { ok: true, code };
}
