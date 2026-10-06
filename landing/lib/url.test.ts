import { describe, expect, it } from 'vitest';
import { normaliseBrandUrl, onboardingHref } from './url';

const ok = (raw: string) => {
  const r = normaliseBrandUrl(raw);
  if (!r.ok) throw new Error(`expected ${raw} to be valid, got ${r.reason}`);
  return r;
};

describe('normaliseBrandUrl', () => {
  it('reduces every common way of typing a site to its host', () => {
    for (const raw of [
      'kelpandco.com',
      'www.kelpandco.com',
      'KelpAndCo.com',
      'https://kelpandco.com',
      'http://www.kelpandco.com/',
      'https://www.kelpandco.com/collections/serums?ref=ig',
      '  kelpandco.com  ',
      'kelpandco.com.',
    ]) {
      expect(ok(raw)).toEqual({ ok: true, kind: 'website', value: 'kelpandco.com' });
    }
  });

  it('keeps subdomains other than www and multi-part TLDs', () => {
    expect(ok('shop.kelpandco.co.uk').value).toBe('shop.kelpandco.co.uk');
    expect(ok('kelp-and-co.com').value).toBe('kelp-and-co.com');
  });

  it('keeps the path of an App Store link, because the host alone names no app', () => {
    expect(ok('https://apps.apple.com/gb/app/kelp/id1234567890')).toEqual({
      ok: true,
      kind: 'app_store',
      value: 'apps.apple.com/gb/app/kelp/id1234567890',
    });
    expect(ok('apps.apple.com/us/app/kelp/id1234567890/').value).toBe(
      'apps.apple.com/us/app/kelp/id1234567890',
    );
  });

  it('rejects an App Store link that is not an app', () => {
    expect(normaliseBrandUrl('apps.apple.com')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('distinguishes empty from invalid', () => {
    expect(normaliseBrandUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    for (const raw of [
      'kelp',
      'kelp and co',
      'kelp.c',
      'kelp.123',
      '-kelp.com',
      'kelp-.com',
      'ftp://kelpandco.com',
      'javascript:alert(1)',
      'https://user:pw@kelpandco.com',
      'kelpandco.com:8080',
      'localhost',
      '192.168.0.1',
    ]) {
      expect(normaliseBrandUrl(raw), raw).toEqual({ ok: false, reason: 'invalid' });
    }
  });
});

describe('onboardingHref', () => {
  it('carries the url, and the plan only when one was chosen', () => {
    expect(onboardingHref('kelpandco.com')).toBe('/onboarding?url=kelpandco.com');
    expect(onboardingHref('kelpandco.com', { plan: 'growth', interval: 'annual' })).toBe(
      '/onboarding?url=kelpandco.com&plan=growth&interval=annual',
    );
  });

  it('encodes an App Store path safely', () => {
    expect(onboardingHref('apps.apple.com/gb/app/kelp/id1')).toBe(
      '/onboarding?url=apps.apple.com%2Fgb%2Fapp%2Fkelp%2Fid1',
    );
  });
});
