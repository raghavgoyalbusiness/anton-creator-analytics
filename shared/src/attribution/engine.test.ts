import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTRIBUTION_WINDOW_HOURS,
  MAX_ATTRIBUTION_WINDOW_HOURS,
  assetUsableAt,
  attributeOrder,
  clampWindowHours,
  summariseDecisions,
  type AttributionOrder,
  type CandidateAsset,
} from './engine.js';

const DAY = 86_400_000;
const AUG = (day: number, hour = 12): Date =>
  new Date(Date.UTC(2026, 7, day, hour, 0, 0));

function asset(over: Partial<CandidateAsset> = {}): CandidateAsset {
  return {
    trackingAssetId: 'asset-amara',
    campaignCreatorId: 'join-amara',
    campaignId: 'campaign-1',
    creatorId: 'creator-amara',
    type: 'discount_code',
    commissionRateBps: 1000,
    commissionRateBasis: 'order_subtotal',
    activeFrom: AUG(1),
    activeUntil: null,
    revokedAt: null,
    status: 'active',
    ...over,
  };
}

function order(over: Partial<AttributionOrder> = {}): AttributionOrder {
  return {
    orderId: 'order-1',
    orderedAt: AUG(5),
    discountCodeKey: null,
    attributionRef: null,
    status: 'confirmed',
    ...over,
  };
}

const WINDOW = DEFAULT_ATTRIBUTION_WINDOW_HOURS;

describe('precedence', () => {
  it('attributes a code redemption as direct', () => {
    const a = asset();
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ' }),
      codeMatches: [a],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(true);
    expect(d.method).toBe('code_redemption');
    expect(d.confidence).toBe('direct');
    expect(d.asset?.campaignCreatorId).toBe('join-amara');
    expect(d.conflict).toBeNull();
  });

  it('attributes a tracked link as inferred, not direct', () => {
    const a = asset({ type: 'tracked_link', trackingAssetId: 'asset-link' });
    const d = attributeOrder({
      order: order({ attributionRef: 'NZJ6G6G' }),
      codeMatches: [],
      refMatches: [a],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(true);
    expect(d.method).toBe('link_last_touch');
    // The whole point of the distinction: a click is a correlation.
    expect(d.confidence).toBe('inferred');
  });

  it('prefers the code when both signals agree', () => {
    const code = asset();
    const link = asset({ type: 'tracked_link', trackingAssetId: 'asset-link' });
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', attributionRef: 'NZJ6G6G' }),
      codeMatches: [code],
      refMatches: [link],
      windowHours: WINDOW,
    });
    expect(d.method).toBe('code_redemption');
    // Same creator, so there is nothing to disagree about.
    expect(d.conflict).toBeNull();
  });

  it('prefers the code and records the conflict when the two disagree', () => {
    const code = asset();
    const link = asset({
      type: 'tracked_link',
      trackingAssetId: 'asset-tom-link',
      campaignCreatorId: 'join-tom',
      creatorId: 'creator-tom',
    });
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', attributionRef: 'TOMLINK' }),
      codeMatches: [code],
      refMatches: [link],
      windowHours: WINDOW,
    });
    expect(d.method).toBe('code_redemption');
    expect(d.asset?.creatorId).toBe('creator-amara');
    expect(d.conflict).toEqual({
      losingMethod: 'link_last_touch',
      losingCampaignCreatorId: 'join-tom',
      losingTrackingAssetId: 'asset-tom-link',
    });
  });

  it('falls through to the link when the code is not one of ours', () => {
    const link = asset({ type: 'tracked_link', trackingAssetId: 'asset-link' });
    const d = attributeOrder({
      // A brand's own sitewide sale code, not a creator's.
      order: order({ discountCodeKey: 'SUMMERSALE', attributionRef: 'NZJ6G6G' }),
      codeMatches: [],
      refMatches: [link],
      windowHours: WINDOW,
    });
    expect(d.method).toBe('link_last_touch');
  });
});

describe('never fabricating attribution', () => {
  it('leaves an order with no signal unattributed, with a reason', () => {
    const d = attributeOrder({
      order: order(),
      codeMatches: [],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(false);
    expect(d.method).toBeNull();
    expect(d.unattributedReason).toBe('no_signal');
    expect(d.note).toBeTruthy();
  });

  it('distinguishes an unrecognised code from no code at all', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'SUMMERSALE' }),
      codeMatches: [],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.unattributedReason).toBe('code_not_recognised');
    // The reason has to name the code: this is a conversation with the brand.
    expect(d.note).toContain('SUMMERSALE');
  });

  it('distinguishes an unrecognised link', () => {
    const d = attributeOrder({
      order: order({ attributionRef: 'ZZZZZZZZ' }),
      codeMatches: [],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.unattributedReason).toBe('ref_not_recognised');
  });

  it('never attributes a cancelled order', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', status: 'cancelled' }),
      codeMatches: [asset()],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(false);
    expect(d.unattributedReason).toBe('order_cancelled');
  });

  /** A refunded order was still a sale that happened; the ledger reverses it. */
  it('still attributes a refunded order', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', status: 'refunded' }),
      codeMatches: [asset()],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(true);
  });

  it('never attributes through a revoked asset', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ' }),
      codeMatches: [asset({ revokedAt: AUG(3), status: 'revoked' })],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(false);
    expect(d.unattributedReason).toBe('asset_revoked');
  });

  it('does not fall through from a revoked code to a link for someone else', () => {
    const link = asset({
      type: 'tracked_link',
      trackingAssetId: 'asset-tom-link',
      campaignCreatorId: 'join-tom',
    });
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', attributionRef: 'TOMLINK' }),
      codeMatches: [asset({ revokedAt: AUG(3), status: 'revoked' })],
      refMatches: [link],
      windowHours: WINDOW,
    });
    // The link still wins on its own merits — the code simply did not qualify.
    expect(d.method).toBe('link_last_touch');
    expect(d.asset?.campaignCreatorId).toBe('join-tom');
  });
});

describe('the window', () => {
  it('never attributes an order placed before the asset existed', () => {
    const d = attributeOrder({
      order: order({ orderedAt: AUG(1, 0), discountCodeKey: 'AMARAJQ' }),
      codeMatches: [asset({ activeFrom: AUG(5) })],
      refMatches: [],
      windowHours: MAX_ATTRIBUTION_WINDOW_HOURS,
    });
    expect(d.attributed).toBe(false);
    expect(d.unattributedReason).toBe('outside_window');
  });

  it('attributes inside the grace period after an asset expires, and says so', () => {
    const d = attributeOrder({
      order: order({ orderedAt: AUG(12), discountCodeKey: 'AMARAJQ' }),
      codeMatches: [asset({ activeUntil: AUG(10) })],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(true);
    expect(d.note).toContain('expired');
  });

  it('stops attributing once the grace period is past', () => {
    const d = attributeOrder({
      order: order({ orderedAt: AUG(20), discountCodeKey: 'AMARAJQ' }),
      codeMatches: [asset({ activeUntil: AUG(10) })],
      refMatches: [],
      windowHours: WINDOW,
    });
    expect(d.attributed).toBe(false);
    expect(d.unattributedReason).toBe('outside_window');
  });

  it('records the window that was actually used', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ' }),
      codeMatches: [asset()],
      refMatches: [],
      windowHours: 48,
    });
    // Stored on the row so changing the campaign window later cannot rewrite
    // a report the brand has already read.
    expect(d.windowHoursUsed).toBe(48);
  });

  it('treats an open-ended asset as always in force after its start', () => {
    const v = assetUsableAt(asset({ activeUntil: null }), new Date(AUG(1).getTime() + 400 * DAY), 1);
    expect(v.usable).toBe(true);
    expect(v.outsideActiveWindow).toBe(false);
  });

  it('is exact on the boundary', () => {
    const end = AUG(10);
    const a = asset({ activeUntil: end });
    expect(assetUsableAt(a, end, 24).usable).toBe(true);
    expect(assetUsableAt(a, new Date(end.getTime() + 24 * 3_600_000), 24).usable).toBe(true);
    expect(assetUsableAt(a, new Date(end.getTime() + 24 * 3_600_000 + 1), 24).usable).toBe(false);
  });
});

describe('clampWindowHours', () => {
  it('defaults when unset', () => {
    expect(clampWindowHours(null)).toBe(DEFAULT_ATTRIBUTION_WINDOW_HOURS);
    expect(clampWindowHours(undefined)).toBe(DEFAULT_ATTRIBUTION_WINDOW_HOURS);
    expect(clampWindowHours(Number.NaN)).toBe(DEFAULT_ATTRIBUTION_WINDOW_HOURS);
  });

  it('never returns zero or a negative window', () => {
    expect(clampWindowHours(0)).toBe(1);
    expect(clampWindowHours(-50)).toBe(1);
  });

  it('caps at the maximum', () => {
    expect(clampWindowHours(9_000)).toBe(MAX_ATTRIBUTION_WINDOW_HOURS);
    expect(clampWindowHours(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ATTRIBUTION_WINDOW_HOURS);
  });

  it('rounds to whole hours', () => {
    expect(clampWindowHours(48.4)).toBe(48);
    expect(clampWindowHours(48.6)).toBe(49);
  });
});

describe('ambiguous matches', () => {
  it('takes the most recently activated asset and is deterministic about it', () => {
    const old = asset({ trackingAssetId: 'old', campaignCreatorId: 'join-old', activeFrom: AUG(1) });
    const fresh = asset({ trackingAssetId: 'new', campaignCreatorId: 'join-new', activeFrom: AUG(4) });
    for (const pair of [[old, fresh], [fresh, old]]) {
      const d = attributeOrder({
        order: order({ discountCodeKey: 'AMARAJQ' }),
        codeMatches: pair,
        refMatches: [],
        windowHours: WINDOW,
      });
      expect(d.asset?.trackingAssetId).toBe('new');
    }
  });
});

describe('summariseDecisions', () => {
  it('reports unattributed beside attributed, never hiding it', () => {
    const decisions = [
      attributeOrder({
        order: order({ orderId: 'a', discountCodeKey: 'AMARAJQ' }),
        codeMatches: [asset()],
        refMatches: [],
        windowHours: WINDOW,
      }),
      attributeOrder({
        order: order({ orderId: 'b', attributionRef: 'NZJ6G6G' }),
        codeMatches: [],
        refMatches: [asset({ type: 'tracked_link' })],
        windowHours: WINDOW,
      }),
      attributeOrder({
        order: order({ orderId: 'c' }),
        codeMatches: [],
        refMatches: [],
        windowHours: WINDOW,
      }),
      attributeOrder({
        order: order({ orderId: 'd', discountCodeKey: 'SUMMERSALE' }),
        codeMatches: [],
        refMatches: [],
        windowHours: WINDOW,
      }),
    ];

    const s = summariseDecisions(decisions);
    expect(s.total).toBe(4);
    expect(s.attributed).toBe(2);
    expect(s.unattributed).toBe(2);
    expect(s.byMethod.code_redemption).toBe(1);
    expect(s.byMethod.link_last_touch).toBe(1);
    expect(s.byReason.no_signal).toBe(1);
    expect(s.byReason.code_not_recognised).toBe(1);
    // The counts must reconcile, or the brand report is arithmetic nobody can follow.
    expect(s.attributed + s.unattributed).toBe(s.total);
  });

  it('counts conflicts separately from attributions', () => {
    const d = attributeOrder({
      order: order({ discountCodeKey: 'AMARAJQ', attributionRef: 'TOMLINK' }),
      codeMatches: [asset()],
      refMatches: [asset({ type: 'tracked_link', campaignCreatorId: 'join-tom' })],
      windowHours: WINDOW,
    });
    const s = summariseDecisions([d]);
    expect(s.attributed).toBe(1);
    expect(s.conflicts).toBe(1);
  });

  it('is empty-safe', () => {
    const s = summariseDecisions([]);
    expect(s).toMatchObject({ total: 0, attributed: 0, unattributed: 0, conflicts: 0 });
  });
});
