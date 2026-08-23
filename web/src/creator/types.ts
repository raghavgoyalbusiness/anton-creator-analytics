import type { PostFormat, Platform } from '@anton/shared';

/** The shape /api/creator/session returns. Mirrors the route, not the schema. */
export interface CreatorSessionResponse {
  creator: {
    id: string;
    displayName: string;
    handles: { platform: Platform; handle: string }[];
  };
  consent: {
    required: boolean;
    reason: 'not_given' | 'document_changed' | null;
    version: string;
    text: string;
    grantedAt: string | null;
  };
  campaigns: CampaignSummary[];
  submissions: SubmissionSummary[];
  link: { expiresAt: string };
}

export interface CampaignSummary {
  id: string;
  name: string;
  brief: string;
  platforms: Platform[];
  startDate: string;
  endDate: string;
  status: string;
  deliverableSpec: { format: PostFormat; count: number }[];
  outstanding: { format: PostFormat; required: number; submitted: number }[];
}

export interface SubmissionSummary {
  id: string;
  campaignId: string;
  platform: Platform;
  format: PostFormat;
  postedAt: string;
  publicUrl: string | null;
  state: 'processing' | 'received' | 'rejected';
}

export interface PresignResponse {
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  key: string;
  expiresAt: string;
  maxBytes: number;
}

export const FORMAT_LABELS: Record<PostFormat, string> = {
  reel: 'Reel',
  story: 'Story',
  feed: 'Feed post',
  carousel: 'Carousel',
  tiktok_video: 'TikTok video',
};
