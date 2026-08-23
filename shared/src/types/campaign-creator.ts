import type { Money } from './common.js';

/**
 * The join carries its own lifecycle. Ordered: a creator moves forward through
 * these, and the nudge list is built from how long someone has sat in one.
 */
export type CampaignCreatorStatus =
  | 'invited'
  | 'accepted'
  | 'declined'
  | 'shipped'
  | 'posted'
  | 'reported'
  | 'paid';

export const CAMPAIGN_CREATOR_STATUSES = [
  'invited',
  'accepted',
  'declined',
  'shipped',
  'posted',
  'reported',
  'paid',
] as const satisfies readonly CampaignCreatorStatus[];

/**
 * Rank used by the nudge list to ask "who is stuck before stage X". `declined`
 * is terminal and deliberately sorts above `paid` so it is never treated as an
 * incomplete state needing a chase.
 */
export const CAMPAIGN_CREATOR_STAGE_ORDER: Readonly<Record<CampaignCreatorStatus, number>> =
  Object.freeze({
    invited: 0,
    accepted: 1,
    shipped: 2,
    posted: 3,
    reported: 4,
    paid: 5,
    declined: 99,
  });

export interface StatusTransition {
  readonly from: CampaignCreatorStatus | null;
  readonly to: CampaignCreatorStatus;
  readonly at: Date;
  /** Operator id, or 'creator' when the creator's own action moved it. */
  readonly by: string;
  readonly note: string | null;
}

export interface CampaignCreator {
  readonly id: string;
  readonly campaignId: string;
  readonly creatorId: string;
  readonly status: CampaignCreatorStatus;
  readonly agreedRate: Money | null;
  readonly productShipped: boolean;
  readonly shippedAt: Date | null;
  readonly trackingNumber: string | null;
  readonly assignedDiscountCodeId: string | null;
  readonly assignedTrackingLinkId: string | null;
  readonly invitedAt: Date | null;
  readonly respondedAt: Date | null;
  readonly firstPostedAt: Date | null;
  readonly lastSubmissionAt: Date | null;
  readonly paidAt: Date | null;
  /** Append-only. Every status change writes here; nothing is edited in place. */
  readonly history: readonly StatusTransition[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
