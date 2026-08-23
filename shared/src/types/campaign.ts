import type { CurrencyCode, Money, PostFormat, Platform } from './common.js';

export type CompensationModel = 'gifted' | 'flat_fee' | 'affiliate' | 'hybrid';
export const COMPENSATION_MODELS = [
  'gifted',
  'flat_fee',
  'affiliate',
  'hybrid',
] as const satisfies readonly CompensationModel[];

export type CampaignStatus = 'draft' | 'live' | 'closed' | 'archived';
export const CAMPAIGN_STATUSES = [
  'draft',
  'live',
  'closed',
  'archived',
] as const satisfies readonly CampaignStatus[];

/** "2 reels + 3 stories" expressed so the nudge list can compute what is owed. */
export interface DeliverableSpecItem {
  readonly format: PostFormat;
  readonly count: number;
}

/** A UTM-tagged destination issued to one creator, or to the campaign at large. */
export interface TrackingLink {
  readonly id: string;
  readonly label: string;
  readonly destinationUrl: string;
  readonly utmSource: string;
  readonly utmMedium: string;
  readonly utmCampaign: string;
  readonly utmContent: string | null;
  /** null = campaign-wide link, not assigned to a specific creator. */
  readonly assignedCreatorId: string | null;
  readonly issuedAt: Date;
}

export interface DiscountCode {
  readonly id: string;
  readonly code: string;
  readonly assignedCreatorId: string | null;
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
  /**
   * Redemption counts are only ever populated from a figure the operator enters
   * from the brand's own commerce platform. Never inferred, never modelled.
   * null means "the brand has not reported redemptions", which the brand report
   * must render as exactly that, not as zero sales.
   */
  readonly reportedRedemptions: number | null;
  readonly reportedRevenue: Money | null;
  readonly reportedAt: Date | null;
  readonly reportedBySource: string | null;
}

export interface Campaign {
  readonly id: string;
  readonly brandId: string;
  readonly name: string;
  readonly brief: string;
  readonly objective: string;
  readonly status: CampaignStatus;
  readonly platforms: readonly Platform[];
  readonly startDate: Date;
  readonly endDate: Date;
  readonly deliverableSpec: readonly DeliverableSpecItem[];
  readonly compensationModel: CompensationModel;
  readonly currency: CurrencyCode;
  readonly budgetTotal: Money;
  readonly defaultPerCreatorRate: Money;
  readonly trackingLinks: readonly TrackingLink[];
  readonly discountCodes: readonly DiscountCode[];
  /**
   * The mega-influencer figure the operator types in for the comparison panel.
   * Explicitly labelled in the report as a benchmark supplied by Anton, not a
   * measured result. null = no comparison panel is rendered.
   */
  readonly megaBenchmark: MegaInfluencerBenchmark | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MegaInfluencerBenchmark {
  /** Free text, e.g. "Typical 1.2M-follower UK lifestyle creator, agency quote". */
  readonly label: string;
  readonly quotedFee: Money;
  readonly quotedReach: number;
  /** Where the operator got the figure. Rendered verbatim next to the number. */
  readonly sourceNote: string;
  readonly enteredAt: Date;
  readonly enteredByOperatorId: string;
}
