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

export type CurrencyCode = 'GBP' | 'USD' | 'EUR' | 'INR';
export const CURRENCY_CODES = ['GBP', 'USD', 'EUR', 'INR'] as const satisfies readonly CurrencyCode[];

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
