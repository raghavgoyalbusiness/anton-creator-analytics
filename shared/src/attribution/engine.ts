import type { BasisPoints, RateBasis } from '../money/commission.js';
import type { AttributionMethod, TrackingAssetType } from '../types/commerce.js';
import { confidenceFor } from '../types/commerce.js';

/**
 * Deciding which creator, if any, an order belongs to.
 *
 * The rule that governs everything here: never fabricate attribution. An order
 * with no evidence pointing at a creator is unattributed, and unattributed is
 * a first-class outcome carrying a stated reason — not a zero, not a guess,
 * and not silently dropped so the attributed share looks better than it is.
 *
 * Pure and synchronous. Every candidate is fetched by the caller and handed in,
 * so the decision can be replayed against a fixture and argued with.
 */

/** The default, applied when neither the campaign nor the brand overrides it. */
export const DEFAULT_ATTRIBUTION_WINDOW_HOURS = 7 * 24;

/** Beyond this, a click is not evidence of anything. */
export const MAX_ATTRIBUTION_WINDOW_HOURS = 30 * 24;

export interface CandidateAsset {
  readonly trackingAssetId: string;
  readonly campaignCreatorId: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly type: TrackingAssetType;
  readonly commissionRateBps: BasisPoints;
  readonly commissionRateBasis: RateBasis;
  readonly activeFrom: Date;
  readonly activeUntil: Date | null;
  readonly revokedAt: Date | null;
  /** 'active' | 'expired' | 'revoked' */
  readonly status: string;
}

export interface AttributionOrder {
  readonly orderId: string;
  readonly orderedAt: Date;
  readonly discountCodeKey: string | null;
  readonly attributionRef: string | null;
  readonly status: string;
}

export type UnattributedReason =
  | 'no_signal'
  | 'code_not_recognised'
  | 'ref_not_recognised'
  | 'asset_revoked'
  | 'outside_window'
  | 'order_cancelled';

export interface AttributionDecision {
  readonly orderId: string;
  readonly attributed: boolean;
  readonly method: AttributionMethod | null;
  readonly confidence: 'direct' | 'inferred' | null;
  readonly asset: CandidateAsset | null;
  readonly windowHoursUsed: number;
  readonly unattributedReason: UnattributedReason | null;
  /**
   * Set when a second method pointed somewhere else. The order is still
   * attributed by precedence — this records what precedence overruled, so a
   * pattern of them is visible rather than lost.
   */
  readonly conflict: {
    readonly losingMethod: AttributionMethod;
    readonly losingCampaignCreatorId: string;
    readonly losingTrackingAssetId: string;
  } | null;
  readonly note: string | null;
}

export interface AttributionInput {
  readonly order: AttributionOrder;
  /** Assets whose matchKey equals the order's folded discount code. */
  readonly codeMatches: readonly CandidateAsset[];
  /** Assets whose short code equals the order's recorded attributionRef. */
  readonly refMatches: readonly CandidateAsset[];
  readonly windowHours: number;
}

const HOUR_MS = 3_600_000;

/**
 * Is this asset usable for an order placed at this moment?
 *
 * The grace period is the attribution window, and it applies at the END only.
 * An order placed before an asset existed cannot have been caused by it, and
 * no window makes that true; an order placed shortly after a code expired is
 * the ordinary case of a customer acting on a post they saw last week.
 */
export function assetUsableAt(
  asset: CandidateAsset,
  at: Date,
  windowHours: number,
): { usable: boolean; reason: UnattributedReason | null; outsideActiveWindow: boolean } {
  if (asset.revokedAt !== null || asset.status === 'revoked') {
    return { usable: false, reason: 'asset_revoked', outsideActiveWindow: false };
  }
  if (at.getTime() < asset.activeFrom.getTime()) {
    return { usable: false, reason: 'outside_window', outsideActiveWindow: true };
  }
  if (asset.activeUntil === null) {
    return { usable: true, reason: null, outsideActiveWindow: false };
  }

  const endMs = asset.activeUntil.getTime();
  if (at.getTime() <= endMs) {
    return { usable: true, reason: null, outsideActiveWindow: false };
  }
  if (at.getTime() <= endMs + windowHours * HOUR_MS) {
    return { usable: true, reason: null, outsideActiveWindow: true };
  }
  return { usable: false, reason: 'outside_window', outsideActiveWindow: false };
}

/**
 * Picks one asset from several that all match.
 *
 * Two assets matching the same signal is a data problem — the unique index on
 * (brand, matchKey) stops it for codes — but reassignment and re-issue can
 * produce it transiently. The most recently activated one wins, because it is
 * the one in force, and the caller is told a choice was made.
 */
function mostRecent(assets: readonly CandidateAsset[]): CandidateAsset | null {
  if (assets.length === 0) return null;
  return [...assets].sort((a, b) => b.activeFrom.getTime() - a.activeFrom.getTime())[0] ?? null;
}

/**
 * The precedence: code redemption, then link last-touch, then unattributed.
 *
 * A code is a deliberate act — the customer typed the creator's name into a
 * checkout field. A link is a correlation: a browser saw the link and an order
 * followed. When both point at the same creator that is corroboration; when
 * they point at different ones, the code wins and the disagreement is recorded.
 */
export function attributeOrder(input: AttributionInput): AttributionDecision {
  const { order, windowHours } = input;

  const base = {
    orderId: order.orderId,
    windowHoursUsed: windowHours,
  } as const;

  const unattributed = (reason: UnattributedReason, note: string | null = null): AttributionDecision => ({
    ...base,
    attributed: false,
    method: null,
    confidence: null,
    asset: null,
    unattributedReason: reason,
    conflict: null,
    note,
  });

  /**
   * A cancelled order was never a sale. Attributing it would put a line in a
   * brand report for revenue that does not exist.
   */
  if (order.status === 'cancelled') {
    return unattributed('order_cancelled', 'the order was cancelled');
  }

  const hasCode = order.discountCodeKey !== null && order.discountCodeKey.length > 0;
  const hasRef = order.attributionRef !== null && order.attributionRef.length > 0;

  if (!hasCode && !hasRef) return unattributed('no_signal', 'no code and no tracked link on the order');

  // ---- code redemption

  const codeAsset = mostRecent(input.codeMatches);
  let codeVerdict: ReturnType<typeof assetUsableAt> | null = null;
  if (codeAsset) codeVerdict = assetUsableAt(codeAsset, order.orderedAt, windowHours);

  // ---- link last touch

  const refAsset = mostRecent(input.refMatches);
  let refVerdict: ReturnType<typeof assetUsableAt> | null = null;
  if (refAsset) refVerdict = assetUsableAt(refAsset, order.orderedAt, windowHours);

  const codeWins = codeAsset !== null && codeVerdict?.usable === true;
  const refWins = refAsset !== null && refVerdict?.usable === true;

  if (codeWins && codeAsset) {
    const conflict =
      refWins && refAsset && refAsset.campaignCreatorId !== codeAsset.campaignCreatorId
        ? {
            losingMethod: 'link_last_touch' as const,
            losingCampaignCreatorId: refAsset.campaignCreatorId,
            losingTrackingAssetId: refAsset.trackingAssetId,
          }
        : null;

    return {
      ...base,
      attributed: true,
      method: 'code_redemption',
      confidence: confidenceFor('code_redemption'),
      asset: codeAsset,
      unattributedReason: null,
      conflict,
      note: codeVerdict?.outsideActiveWindow
        ? 'the code had expired when the order was placed, but within the attribution window'
        : null,
    };
  }

  if (refWins && refAsset) {
    return {
      ...base,
      attributed: true,
      method: 'link_last_touch',
      confidence: confidenceFor('link_last_touch'),
      asset: refAsset,
      unattributedReason: null,
      conflict: null,
      note: refVerdict?.outsideActiveWindow
        ? 'the link had expired when the order was placed, but within the attribution window'
        : null,
    };
  }

  /**
   * Nothing won. The reason has to name the signal that was present, because
   * "unattributed" for an order carrying a creator's own code is a different
   * conversation with the brand than one carrying nothing at all.
   */
  if (hasCode && codeAsset === null) {
    return unattributed(
      'code_not_recognised',
      `the order used "${order.discountCodeKey}", which is not a code Anton issued for this brand`,
    );
  }
  if (hasCode && codeVerdict) {
    return unattributed(
      codeVerdict.reason ?? 'outside_window',
      codeVerdict.reason === 'asset_revoked'
        ? 'the code was revoked before this order'
        : 'the order falls outside the window the code was valid for',
    );
  }
  if (hasRef && refAsset === null) {
    return unattributed('ref_not_recognised', 'the landing link is not one Anton issued');
  }
  return unattributed(
    refVerdict?.reason ?? 'outside_window',
    refVerdict?.reason === 'asset_revoked'
      ? 'the link was revoked before this order'
      : 'the order falls outside the window the link was valid for',
  );
}

/* ------------------------------------------------------------- summary */

export interface AttributionSummary {
  readonly total: number;
  readonly attributed: number;
  readonly unattributed: number;
  readonly byMethod: Readonly<Record<AttributionMethod, number>>;
  readonly byReason: Readonly<Partial<Record<UnattributedReason, number>>>;
  readonly conflicts: number;
}

/**
 * What a run did, in the shape the brand report needs.
 *
 * The unattributed count is reported next to the attributed one everywhere it
 * appears. A method breakdown that quietly omits the orders no creator can
 * claim overstates the programme, and the whole commercial argument rests on
 * the numbers being ones a sceptical brand can check.
 */
export function summariseDecisions(
  decisions: readonly AttributionDecision[],
): AttributionSummary {
  const byMethod: Record<AttributionMethod, number> = {
    code_redemption: 0,
    link_last_touch: 0,
    manual_assignment: 0,
  };
  const byReason: Partial<Record<UnattributedReason, number>> = {};
  let attributed = 0;
  let conflicts = 0;

  for (const d of decisions) {
    if (d.attributed && d.method) {
      attributed += 1;
      byMethod[d.method] += 1;
      if (d.conflict) conflicts += 1;
    } else if (d.unattributedReason) {
      byReason[d.unattributedReason] = (byReason[d.unattributedReason] ?? 0) + 1;
    }
  }

  return {
    total: decisions.length,
    attributed,
    unattributed: decisions.length - attributed,
    byMethod,
    byReason,
    conflicts,
  };
}

/** Clamps an operator-supplied window to something defensible. */
export function clampWindowHours(hours: number | null | undefined): number {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) {
    return DEFAULT_ATTRIBUTION_WINDOW_HOURS;
  }
  const whole = Math.round(hours);
  if (whole < 1) return 1;
  return Math.min(whole, MAX_ATTRIBUTION_WINDOW_HOURS);
}
