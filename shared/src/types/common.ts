/**
 * Primitives shared across every collection.
 *
 * Money rule: never a float. All monetary values are integer MINOR units
 * (pence for GBP, cents for USD) paired with an explicit currency code.
 * A rate of £45.00 is stored as { amountMinor: 4500, currency: 'GBP' }.
 */

export type Platform = 'instagram' | 'tiktok';
export const PLATFORMS = ['instagram', 'tiktok'] as const satisfies readonly Platform[];

export type PostFormat = 'reel' | 'story' | 'feed' | 'carousel' | 'tiktok_video';
export const POST_FORMATS = [
  'reel',
  'story',
  'feed',
  'carousel',
  'tiktok_video',
] as const satisfies readonly PostFormat[];

/**
 * Phase 2 seam. Every metric that lands on a Post carries the mechanism that
 * produced it. An OAuth adapter drops in behind the same ingestion interface
 * without invalidating historical `screenshot` rows.
 */
export type MetricSource = 'screenshot' | 'instagram_oauth' | 'tiktok_oauth' | 'manual';
export const METRIC_SOURCES = [
  'screenshot',
  'instagram_oauth',
  'tiktok_oauth',
  'manual',
] as const satisfies readonly MetricSource[];

/**
 * Any ISO 4217 alphabetic code.
 *
 * Deliberately a validated string rather than a closed union. A brand uploads
 * its own order export; the moment one of them trades in AUD or SEK, a union
 * turns a legitimate order into a validation failure at ingest, and the
 * pressure is then to coerce it into a currency it is not. Validate the shape,
 * store what the brand actually sold in.
 */
export type CurrencyCode = string;

/** Shape check only. Does not assert the code is in circulation. */
export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(value);
}

/**
 * Codes offered first in a picker. Not a whitelist — anything ISO-shaped is
 * accepted; these are simply the ones this operator sees most.
 */
export const COMMON_CURRENCIES = ['GBP', 'USD', 'EUR', 'INR'] as const;

/**
 * Minor-unit exponents for the currencies that are not 2dp.
 *
 * JPY has no minor unit at all, so ¥100 is amountMinor 100, not 10000. Getting
 * this wrong inflates or deflates a figure by 100x silently, which is the worst
 * possible failure mode for a number a brand pays against.
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = Object.freeze({
  JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, HUF: 0, TWD: 0, UGX: 0, XAF: 0, XOF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
});

/** How many minor units make one major unit. Defaults to 100. */
export function minorUnitExponent(currency: CurrencyCode): number {
  return MINOR_UNIT_EXPONENTS[currency] ?? 2;
}

export function minorUnitsPerMajor(currency: CurrencyCode): number {
  return 10 ** minorUnitExponent(currency);
}

/** Integer minor units. Never a float, never a bare number without a currency. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export type IsoCountryCode = string; // ISO 3166-1 alpha-2, uppercase
export type LanguageCode = string; // ISO 639-1, lowercase

/** Who performed an auditable action. */
export interface ActorRef {
  readonly operatorId: string;
  readonly email: string;
}
