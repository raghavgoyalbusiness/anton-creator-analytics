import { CODE_ALPHABET } from '../types/commerce.js';

/**
 * Discount code and short-link generation.
 *
 * Pure. Randomness is injected so the generator can be tested deterministically
 * and so the server can supply a CSPRNG rather than Math.random — a guessable
 * discount code is a discount anyone can claim.
 */

/** Returns an integer in [0, max). */
export type RandomInt = (max: number) => number;

/**
 * The random suffix length.
 *
 * Five characters of a 27-symbol alphabet is ~14.3 million combinations, which
 * is not a security boundary on its own — the collision check is — but is short
 * enough that a creator can read it aloud in a video and a viewer can type what
 * they heard on the first try.
 */
export const CODE_SUFFIX_LENGTH = 5;

/** Short links are typed less often than codes, so they can afford more entropy. */
export const SHORT_CODE_LENGTH = 7;

export const MAX_STUB_LENGTH = 12;

/**
 * Normalises a creator's name into a code stub.
 *
 * The stub is the part the creator recognises as theirs. Diacritics are folded
 * rather than stripped, so "Sofía" becomes SOFIA rather than SOFA — a code a
 * creator finds insulting is a code they will not promote.
 */
export function normaliseStub(raw: string): string {
  const folded = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  return folded.slice(0, MAX_STUB_LENGTH);
}

export function isValidStub(stub: string): boolean {
  return /^[A-Z]{2,12}$/.test(stub);
}

function randomString(length: number, randomInt: RandomInt): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] ?? '';
  }
  return out;
}

/**
 * One candidate code. The caller checks it against codes already issued for
 * that brand and asks again on collision.
 */
export function generateCodeCandidate(stub: string, randomInt: RandomInt): string {
  const normalised = normaliseStub(stub);
  if (!isValidStub(normalised)) {
    throw new RangeError(
      `code stub "${stub}" has fewer than two usable letters; supply one explicitly`,
    );
  }
  return `${normalised}${randomString(CODE_SUFFIX_LENGTH, randomInt)}`;
}

export function generateShortCode(randomInt: RandomInt): string {
  return randomString(SHORT_CODE_LENGTH, randomInt);
}

/**
 * Normalises a code as typed by a customer at checkout.
 *
 * A customer types what they heard, on a phone keyboard, possibly with a space
 * or a hyphen in it. This maps the near-misses onto the characters the alphabet
 * actually uses, so a code is not lost to a lowercase L that should have been a
 * one — matching at checkout is the brand's job, but Anton has to match the
 * SAME code back from the order export, and that export contains whatever the
 * customer's platform recorded.
 */
export function normaliseTypedCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[O]/g, '0')
    .replace(/[IL]/g, '1')
    // Fold the ambiguous pairs onto the characters the alphabet does not use,
    // then back onto the ones it does, so 0/O and 1/I/L all collapse together.
    .replace(/0/g, 'Q')
    .replace(/1/g, 'J');
}

/**
 * Do two codes match, allowing for how a human typed one of them?
 *
 * Compared through the same normalisation on both sides so the relation is
 * symmetric — an asymmetric match is one that works in tests and fails on the
 * half of real orders where the strings arrive the other way round.
 */
export function codesMatch(issued: string, typed: string): boolean {
  return normaliseTypedCode(issued) === normaliseTypedCode(typed);
}

/**
 * Whether a generated code accidentally spells something.
 *
 * The alphabet excludes vowels precisely so the random half cannot, but the
 * stub is chosen by an operator and the join between them can still produce a
 * substring nobody wants on a creator's channel. This is a last check, not the
 * primary defence.
 */
const UNFORTUNATE = ['FCK', 'SHT', 'CNT', 'DCK', 'TWT', 'PSS', 'BTCH'];

export function looksUnfortunate(code: string): boolean {
  const compact = code.toUpperCase();
  return UNFORTUNATE.some((bad) => compact.includes(bad));
}

/**
 * Draws a code that is unique against `isTaken` and not unfortunate.
 *
 * Fails loudly after `maxAttempts` rather than falling back to reuse or to a
 * longer code: a silent format change breaks the brand's own checkout config,
 * and reusing a code attributes one creator's sales to another.
 */
export function drawUniqueCode(params: {
  stub: string;
  randomInt: RandomInt;
  isTaken: (code: string) => boolean;
  maxAttempts?: number;
}): string {
  const maxAttempts = params.maxAttempts ?? 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generateCodeCandidate(params.stub, params.randomInt);
    if (!params.isTaken(candidate) && !looksUnfortunate(candidate)) return candidate;
  }
  throw new Error(
    `could not draw a free code for stub "${params.stub}" in ${maxAttempts} attempts. ` +
      'Codes are not being reused; check for an exhausted namespace or a stuck generator.',
  );
}

export function drawUniqueShortCode(params: {
  randomInt: RandomInt;
  isTaken: (code: string) => boolean;
  maxAttempts?: number;
}): string {
  const maxAttempts = params.maxAttempts ?? 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const candidate = generateShortCode(params.randomInt);
    if (!params.isTaken(candidate)) return candidate;
  }
  throw new Error(`could not draw a free short code in ${maxAttempts} attempts`);
}

/* ------------------------------------------------------------ tracked links */

export interface TrackedLinkParams {
  readonly destinationUrl: string;
  readonly shortCode: string;
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign: string;
  readonly utmContent: string;
}

/**
 * Builds the destination with UTM parameters attached.
 *
 * Existing query parameters on the brand's URL are preserved; ours are added
 * alongside. Overwriting a brand's own parameters would break their landing
 * page, and silently dropping them would break their own analytics.
 */
export function buildTrackedUrl(params: TrackedLinkParams): string {
  const url = new URL(params.destinationUrl);
  url.searchParams.set('utm_source', params.utmSource ?? 'anton');
  url.searchParams.set('utm_medium', params.utmMedium ?? 'creator');
  url.searchParams.set('utm_campaign', params.utmCampaign);
  url.searchParams.set('utm_content', params.utmContent);
  url.searchParams.set('anton_ref', params.shortCode);
  return url.toString();
}
