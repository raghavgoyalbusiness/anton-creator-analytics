/**
 * Turning whatever someone types into the hero input into something we can
 * read.
 *
 * Accepts a website in any of the shapes people actually type it — with or
 * without a scheme, "www.", a path, a trailing slash, capitals — and an App
 * Store link. A website is reduced to its host, because that is what the brand
 * profile is built from; an App Store link keeps its path, because the host
 * alone says nothing about which app.
 */

export type NormalisedUrl =
  | { ok: true; kind: 'website' | 'app_store'; value: string }
  | { ok: false; reason: 'empty' | 'invalid' };

const APP_STORE_HOSTS = new Set(['apps.apple.com', 'itunes.apple.com']);

/** One DNS label: letters, digits, hyphens, not starting or ending in a hyphen. */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** The last label must be letters (or punycode), at least two of them. */
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

export function normaliseBrandUrl(raw: string): NormalisedUrl {
  const input = raw.trim();
  if (input.length === 0) return { ok: false, reason: 'empty' };
  if (/\s/.test(input) || input.length > 2_000) return { ok: false, reason: 'invalid' };

  let parsed: URL;
  try {
    // A scheme is added when missing so "kelpandco.com/shop" parses as a host
    // and a path rather than as a relative path.
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'invalid' };
  if (parsed.username || parsed.password || parsed.port) return { ok: false, reason: 'invalid' };

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');

  if (APP_STORE_HOSTS.has(host)) {
    // A bare apps.apple.com is not an app.
    if (!/\/app\//.test(parsed.pathname)) return { ok: false, reason: 'invalid' };
    const path = parsed.pathname.replace(/\/+$/, '');
    return { ok: true, kind: 'app_store', value: `apps.apple.com${path}` };
  }

  const labels = host.split('.');
  if (labels.length < 2) return { ok: false, reason: 'invalid' };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'invalid' };
  if (!TLD.test(labels[labels.length - 1] ?? '')) return { ok: false, reason: 'invalid' };

  return { ok: true, kind: 'website', value: host };
}

/** Where a valid submission goes, carrying any plan the visitor picked. */
export function onboardingHref(
  url: string,
  context: { plan?: string | null; interval?: string | null } = {},
): string {
  const params = new URLSearchParams({ url });
  if (context.plan) params.set('plan', context.plan);
  if (context.interval) params.set('interval', context.interval);
  return `/onboarding?${params.toString()}`;
}
