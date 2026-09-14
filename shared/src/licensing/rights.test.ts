import { describe, expect, it } from 'vitest';
import {
  WORLDWIDE,
  adReadiness,
  licenceStatus,
  needsAttentionSoon,
  normaliseAdCode,
  permits,
  permittedInTerritory,
  type AdAuthorisationLike,
  type LicenceLike,
} from './rights.js';

const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day, 12, 0, 0));
const NOW = AUG(15);

function licence(over: Partial<LicenceLike> = {}): LicenceLike {
  return {
    permittedUses: ['organic_reshare'],
    territory: [WORLDWIDE],
    grantedAt: AUG(1),
    revokedAt: null,
    startsAt: AUG(1),
    endsAt: AUG(31),
    nameAndLikenessPermitted: false,
    modificationPermitted: false,
    whitelistingPermitted: false,
    ...over,
  };
}

function authorisation(over: Partial<AdAuthorisationLike> = {}): AdAuthorisationLike {
  return {
    platform: 'tiktok_spark',
    code: 'SPARK-ABC123',
    providedAt: AUG(2),
    expiresAt: AUG(30),
    revokedAt: null,
    ...over,
  };
}

/**
 * The rule the whole module exists to enforce: silence is never permission.
 */
describe('the default is no', () => {
  it('permits nothing without a licence', () => {
    expect(permits(null, 'organic_reshare', NOW)).toBe(false);
    expect(permits(null, 'paid_amplification', NOW)).toBe(false);
    const status = licenceStatus(null, NOW);
    expect(status.state).toBe('none');
    expect(status.usableNow).toBe(false);
    expect(status.summary).toContain('may not reshare');
  });

  it('permits nothing while the creator has not agreed', () => {
    const l = licence({ grantedAt: null });
    expect(licenceStatus(l, NOW).state).toBe('awaiting_creator');
    expect(permits(l, 'organic_reshare', NOW)).toBe(false);
  });

  it('permits nothing after the creator withdraws', () => {
    const l = licence({ revokedAt: AUG(10) });
    expect(licenceStatus(l, NOW).state).toBe('revoked');
    expect(permits(l, 'organic_reshare', NOW)).toBe(false);
  });

  it('permits only the uses actually granted', () => {
    const l = licence({ permittedUses: ['organic_reshare', 'website'] });
    expect(permits(l, 'organic_reshare', NOW)).toBe(true);
    expect(permits(l, 'website', NOW)).toBe(true);
    expect(permits(l, 'paid_amplification', NOW)).toBe(false);
    expect(permits(l, 'print', NOW)).toBe(false);
  });

  /** An empty territory list grants nowhere, not everywhere. */
  it('grants nowhere when no territory is named', () => {
    expect(permittedInTerritory(licence({ territory: [] }), 'GB')).toBe(false);
    expect(permittedInTerritory(null, 'GB')).toBe(false);
  });

  it('honours a named territory and WORLDWIDE', () => {
    expect(permittedInTerritory(licence({ territory: ['GB', 'IE'] }), 'GB')).toBe(true);
    expect(permittedInTerritory(licence({ territory: ['GB', 'IE'] }), 'gb')).toBe(true);
    expect(permittedInTerritory(licence({ territory: ['GB'] }), 'US')).toBe(false);
    expect(permittedInTerritory(licence({ territory: [WORLDWIDE] }), 'US')).toBe(true);
  });
});

describe('dates', () => {
  it('is not yet in force before it starts', () => {
    const status = licenceStatus(licence({ startsAt: AUG(20) }), NOW);
    expect(status.state).toBe('not_yet_started');
    expect(status.usableNow).toBe(false);
  });

  it('expires', () => {
    const status = licenceStatus(licence({ endsAt: AUG(10) }), NOW);
    expect(status.state).toBe('expired');
    expect(status.usableNow).toBe(false);
    expect(status.summary).toContain('must stop using');
  });

  it('is inclusive of its boundaries', () => {
    const l = licence({ startsAt: AUG(1), endsAt: AUG(31) });
    expect(licenceStatus(l, AUG(1)).usableNow).toBe(true);
    expect(licenceStatus(l, AUG(31)).usableNow).toBe(true);
    expect(licenceStatus(l, new Date(AUG(31).getTime() + 1)).usableNow).toBe(false);
  });

  it('counts days to expiry, and null for a perpetual licence', () => {
    expect(licenceStatus(licence({ endsAt: AUG(25) }), NOW).daysUntilExpiry).toBe(10);
    const perpetual = licenceStatus(licence({ endsAt: null }), NOW);
    expect(perpetual.daysUntilExpiry).toBeNull();
    expect(perpetual.isPerpetual).toBe(true);
    expect(perpetual.summary).toContain('indefinitely');
  });
});

/**
 * Legal permission and platform permission are separate things that fail
 * independently. Knowing WHICH is missing is the whole question a week before
 * a campaign goes live.
 */
describe('ad readiness', () => {
  it('is ready when the licence covers ads and the code is live', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['paid_amplification'] }),
      authorisation: authorisation(),
      at: NOW,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toEqual([]);
    expect(r.code).toBe('SPARK-ABC123');
    expect(r.whatIsNeeded).toBeNull();
  });

  it('blocks on a licence that does not cover ads, even with a valid code', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['organic_reshare'] }),
      authorisation: authorisation(),
      at: NOW,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers).toContain('licence_does_not_permit_ads');
    expect(r.whatIsNeeded).toContain('does not cover paid amplification');
    // The code is withheld: nobody should be able to copy it out of a list.
    expect(r.code).toBeNull();
  });

  it('blocks on a missing code, even with a licence that covers ads', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['paid_amplification'] }),
      authorisation: null,
      at: NOW,
    });
    expect(r.blockers).toEqual(['no_ad_code']);
    expect(r.whatIsNeeded).toContain('has not supplied an ad authorisation code');
  });

  it('blocks on an expired code and says a new one is needed', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['paid_amplification'] }),
      authorisation: authorisation({ expiresAt: AUG(10) }),
      at: NOW,
    });
    expect(r.blockers).toEqual(['ad_code_expired']);
    expect(r.whatIsNeeded).toContain('needs to issue a new one');
    expect(r.daysUntilCodeExpiry).toBe(-5);
  });

  it('blocks on a withdrawn code', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['paid_amplification'] }),
      authorisation: authorisation({ revokedAt: AUG(12) }),
      at: NOW,
    });
    expect(r.blockers).toEqual(['ad_code_revoked']);
  });

  /** Both can be wrong at once, and both are reported. */
  it('reports every blocker, not just the first', () => {
    const r = adReadiness({ licence: null, authorisation: null, at: NOW });
    expect(r.blockers).toEqual(['no_licence', 'no_ad_code']);
    expect(r.whatIsNeeded).toContain('has not granted a licence');
    expect(r.whatIsNeeded).toContain('has not supplied an ad authorisation code');
  });

  it('treats a code with no stated expiry as live', () => {
    const r = adReadiness({
      licence: licence({ permittedUses: ['paid_amplification'] }),
      authorisation: authorisation({ expiresAt: null }),
      at: NOW,
    });
    expect(r.ready).toBe(true);
    expect(r.daysUntilCodeExpiry).toBeNull();
  });
});

describe('needsAttentionSoon', () => {
  it('flags terms the creator has not answered', () => {
    const r = needsAttentionSoon({ licence: licence({ grantedAt: null }), authorisation: null }, NOW);
    expect(r.urgent).toBe(true);
    expect(r.reasons[0]).toContain('not yet agreed');
  });

  it('flags a licence about to expire', () => {
    const r = needsAttentionSoon({ licence: licence({ endsAt: AUG(20) }), authorisation: null }, NOW);
    expect(r.urgent).toBe(true);
    expect(r.reasons[0]).toContain('expires in 5 days');
  });

  it('flags a code about to expire, and one already gone', () => {
    const soon = needsAttentionSoon(
      { licence: licence({ endsAt: null }), authorisation: authorisation({ expiresAt: AUG(20) }) },
      NOW,
    );
    expect(soon.reasons[0]).toContain('expires in 5 days');

    const gone = needsAttentionSoon(
      { licence: licence({ endsAt: null }), authorisation: authorisation({ expiresAt: AUG(10) }) },
      NOW,
    );
    expect(gone.reasons[0]).toContain('expired 5 days ago');
  });

  it('is quiet when everything is comfortably in force', () => {
    const r = needsAttentionSoon(
      {
        licence: licence({ endsAt: null }),
        authorisation: authorisation({ expiresAt: null }),
      },
      NOW,
    );
    expect(r.urgent).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('does not nag about a code that was already withdrawn', () => {
    const r = needsAttentionSoon(
      {
        licence: licence({ endsAt: null }),
        authorisation: authorisation({ expiresAt: AUG(16), revokedAt: AUG(3) }),
      },
      NOW,
    );
    expect(r.urgent).toBe(false);
  });
});

describe('normaliseAdCode', () => {
  it('accepts a plausible code and trims it', () => {
    const r = normaliseAdCode('  #SPARK_ABC-123  ');
    expect(r).toEqual({ ok: true, code: '#SPARK_ABC-123' });
  });

  /**
   * Loose on format and strict on everything else. Both platforms change code
   * formats without notice, so a stale regex would block real work — but a
   * pasted code with a space in it is an accident that surfaces on the day.
   */
  it('rejects an empty code', () => {
    expect(normaliseAdCode('   ')).toEqual({ ok: false, reason: 'the code is empty' });
  });

  it('rejects a code with a space in the middle', () => {
    const r = normaliseAdCode('SPARK ABC123');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('space');
  });

  it('rejects control characters', () => {
    const r = normaliseAdCode('SPARK ABC');
    expect(r.ok).toBe(false);
  });

  it('rejects something absurdly long', () => {
    const r = normaliseAdCode('A'.repeat(201));
    expect(r.ok).toBe(false);
  });

  it('accepts a code that looks nothing like today’s format', () => {
    // Tomorrow's format is not this module's business to predict.
    expect(normaliseAdCode('a1b2c3d4-e5f6-7890-abcd-ef1234567890').ok).toBe(true);
  });
});
