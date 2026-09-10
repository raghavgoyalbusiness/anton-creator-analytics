import type { CurrencyCode, Money } from './common.js';
import type { BasisPoints, RateBasis } from '../money/commission.js';
import type { CommissionEntryType } from '../money/ledger.js';

/**
 * The attribution and commission layer.
 *
 * Anton calculates money and never moves it. There is no wallet here, no held
 * balance, no payout rail. These models compute what a brand owes a creator and
 * show the same figure to both sides; the brand pays directly.
 */

/* -------------------------------------------------------- tracking assets */

export type TrackingAssetType = 'discount_code' | 'tracked_link';
export const TRACKING_ASSET_TYPES = [
  'discount_code',
  'tracked_link',
] as const satisfies readonly TrackingAssetType[];

export type TrackingAssetStatus = 'active' | 'expired' | 'revoked';
export const TRACKING_ASSET_STATUSES = [
  'active',
  'expired',
  'revoked',
] as const satisfies readonly TrackingAssetStatus[];

/**
 * The alphabet discount codes are drawn from.
 *
 * Excludes 0/O, 1/I/L and the vowels. The first because a creator reads the
 * code aloud in a video and a viewer types what they heard; the second because
 * a randomly generated string that happens to spell something unfortunate goes
 * out on someone's channel with their name on it.
 */
export const CODE_ALPHABET = '23456789BCDFGHJKMNPQRTVWXYZ';

export interface TrackingAsset {
  readonly id: string;
  readonly campaignCreatorId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly brandId: string;
  readonly type: TrackingAssetType;
  /** The code string, or the destination URL with parameters encoded. */
  readonly value: string;
  /** Short path segment for link redirection. Null for discount codes. */
  readonly shortCode: string | null;
  readonly destinationUrl: string | null;
  readonly issuedAt: Date;
  readonly activeFrom: Date;
  readonly activeUntil: Date | null;
  readonly status: TrackingAssetStatus;
  /** Commission terms attached at issue, so a later rate change is not retroactive. */
  readonly commissionRateBps: BasisPoints;
  readonly commissionRateBasis: RateBasis;
  readonly issuedByOperatorId: string;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  readonly createdAt: Date;
}

/** A recorded click on a tracked link, for last-touch attribution. */
export interface LinkClick {
  readonly id: string;
  readonly trackingAssetId: string;
  readonly campaignCreatorId: string;
  readonly clickedAt: Date;
  /**
   * An opaque, salted identifier for the visitor. Never a raw IP, never a
   * durable advertising id — enough to join a click to an order, and nothing
   * that identifies a person outside this join.
   */
  readonly visitorHash: string;
  readonly userAgentFamily: string | null;
  readonly referrerHost: string | null;
}

/* ------------------------------------------------------------------ orders */

export type OrderSourceId = 'manual_csv' | 'shopify_oauth' | 'api';
export const ORDER_SOURCE_IDS = [
  'manual_csv',
  'shopify_oauth',
  'api',
] as const satisfies readonly OrderSourceId[];

export type OrderStatus = 'confirmed' | 'refunded' | 'partially_refunded' | 'cancelled';
export const ORDER_STATUSES = [
  'confirmed',
  'refunded',
  'partially_refunded',
  'cancelled',
] as const satisfies readonly OrderStatus[];

export type CustomerType = 'new' | 'returning' | 'unknown';
export const CUSTOMER_TYPES = ['new', 'returning', 'unknown'] as const satisfies readonly CustomerType[];

export interface Order {
  readonly id: string;
  readonly brandId: string;
  /** The id in the brand's own system. Unique per (brand, source). */
  readonly externalOrderId: string;
  readonly source: OrderSourceId;
  readonly orderedAt: Date;
  readonly total: Money;
  readonly subtotal: Money;
  readonly currency: CurrencyCode;
  readonly discountCodeUsed: string | null;
  readonly customerType: CustomerType;
  readonly status: OrderStatus;
  readonly refundedAmount: Money | null;
  readonly refundedAt: Date | null;
  readonly ingestBatchId: string;
  /**
   * The original row, verbatim.
   *
   * Kept for the same reason the extraction pipeline keeps the raw model
   * output: when a figure is challenged, the source is the only thing that
   * settles it. Never logged at info level — it contains customer data.
   */
  readonly rawRow: Readonly<Record<string, string>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The shape an adapter returns, before it becomes an Order. */
export interface NormalisedOrder {
  readonly externalOrderId: string;
  readonly orderedAt: Date;
  readonly total: Money;
  readonly subtotal: Money;
  readonly discountCodeUsed: string | null;
  readonly customerType: CustomerType;
  readonly status: OrderStatus;
  readonly refundedAmount: Money | null;
  readonly refundedAt: Date | null;
  readonly rawRow: Readonly<Record<string, string>>;
}

export type IngestBatchStatus = 'previewed' | 'committed' | 'rolled_back';

export interface IngestBatch {
  readonly id: string;
  readonly brandId: string;
  readonly source: OrderSourceId;
  readonly status: IngestBatchStatus;
  readonly uploadedByOperatorId: string;
  readonly filename: string | null;
  readonly fileSha256: string | null;
  readonly rowsParsed: number;
  readonly rowsSkipped: number;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly duplicatesInFile: number;
  readonly skipReasons: readonly { row: number; reason: string }[];
  readonly dateRangeFrom: Date | null;
  readonly dateRangeTo: Date | null;
  readonly committedAt: Date | null;
  readonly rolledBackAt: Date | null;
  readonly createdAt: Date;
}

/* ------------------------------------------------------------ attribution */

export type AttributionMethod = 'code_redemption' | 'link_last_touch' | 'manual_assignment';
export const ATTRIBUTION_METHODS = [
  'code_redemption',
  'link_last_touch',
  'manual_assignment',
] as const satisfies readonly AttributionMethod[];

/**
 * How much weight the method carries.
 *
 * A code redemption is direct: the customer typed the creator's code. A link
 * click is inferred: the same browser saw the link and later an order appeared,
 * which is a correlation. The brand report says which is which on the face of
 * it, not in a footnote.
 */
export type AttributionConfidence = 'direct' | 'inferred';

export function confidenceFor(method: AttributionMethod): AttributionConfidence {
  return method === 'link_last_touch' ? 'inferred' : 'direct';
}

export interface Attribution {
  readonly id: string;
  readonly orderId: string;
  readonly campaignCreatorId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly brandId: string;
  readonly method: AttributionMethod;
  readonly confidence: AttributionConfidence;
  readonly attributedAt: Date;
  readonly attributedValue: Money;
  /**
   * The window in force when this ran, stored on the row.
   *
   * Without this, changing a campaign's window silently rewrites history: last
   * month's report would render different numbers than the one the brand read.
   */
  readonly windowHoursUsed: number | null;
  readonly trackingAssetId: string | null;
  readonly linkClickId: string | null;
  /** Set when a later rule reassigns this order. The row itself is never edited. */
  readonly supersededBy: string | null;
  readonly supersededAt: Date | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** Logged when a code and a prior click point at different creators. */
export interface AttributionConflict {
  readonly id: string;
  readonly orderId: string;
  readonly brandId: string;
  readonly winningMethod: AttributionMethod;
  readonly winningCampaignCreatorId: string;
  readonly losingMethod: AttributionMethod;
  readonly losingCampaignCreatorId: string;
  readonly detectedAt: Date;
  readonly reviewedAt: Date | null;
  readonly reviewedByOperatorId: string | null;
}

/* --------------------------------------------------------------- ledger */

export interface CommissionEntry {
  readonly id: string;
  readonly creatorId: string;
  readonly campaignId: string;
  readonly campaignCreatorId: string;
  readonly brandId: string;
  readonly orderId: string | null;
  readonly attributionId: string | null;
  readonly type: CommissionEntryType;
  /** Negative for reversals. */
  readonly amount: Money;
  readonly rateAppliedBps: BasisPoints;
  readonly rateBasis: RateBasis;
  /** The order figure the rate was applied to, recorded so it can be re-derived. */
  readonly basisAmount: Money;
  /** Required for adjustments and reversals. */
  readonly reason: string | null;
  readonly createdAt: Date;
  readonly createdBy: string;
}

/**
 * Payment as the brand reports it.
 *
 * Anton does not move money, so this is a record of something that happened
 * elsewhere, not an instruction. Append-only for the same reason as the
 * ledger: "the brand says it paid £120 on the 3rd" is a claim with a date on
 * it, and overwriting it destroys the only evidence of what was said when.
 */
export interface PaymentRecord {
  readonly id: string;
  readonly creatorId: string;
  readonly campaignId: string;
  readonly brandId: string;
  readonly amount: Money;
  readonly paidAt: Date;
  readonly method: string | null;
  readonly reference: string | null;
  readonly recordedByOperatorId: string;
  readonly recordedAt: Date;
  readonly note: string | null;
}

/* --------------------------------------------------------- trust domains */

/**
 * What an audience comes to a creator FOR — distinct from niche.
 *
 * Niche says "skincare". A trust domain says whether they are trusted for
 * ingredient science or for budget picks, which are different audiences with
 * different conversion behaviour inside the same niche.
 *
 * Seeded vocabulary; custom values are allowed.
 */
export const SEED_TRUST_DOMAINS = [
  'routine_technique',
  'ingredient_science',
  'budget_picks',
  'sensitive_skin',
  'transformation',
  'clinical_authority',
  'lifestyle_adjacent',
] as const;

export type SeedTrustDomain = (typeof SEED_TRUST_DOMAINS)[number];
export type TrustDomain = string;

/**
 * Below this many attributed orders, a per-domain conversion rate is not
 * reported at all. A rate derived from three orders is noise wearing the
 * costume of a finding, and a brand will act on it.
 */
export const MIN_SAMPLE_FOR_DOMAIN_RATE = 25;

/* ------------------------------------------------------- ad authorisation */

export type AdPlatform = 'tiktok_spark' | 'meta_partnership';

export interface AdAuthorisation {
  readonly platform: AdPlatform;
  readonly code: string;
  readonly expiresAt: Date | null;
  readonly providedAt: Date;
}
