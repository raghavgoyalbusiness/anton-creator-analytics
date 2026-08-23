import { z } from 'zod';
import { CONSENT_METHODS, CREATOR_STATUSES } from '../types/creator.js';
import { CAMPAIGN_CREATOR_STATUSES } from '../types/campaign-creator.js';
import { CAMPAIGN_STATUSES, COMPENSATION_MODELS } from '../types/campaign.js';
import { EXTRACTION_STATUSES } from '../types/post.js';
import { METRIC_KEYS } from '../types/metrics.js';
import {
  currencyCodeSchema,
  handleSchema,
  httpUrlSchema,
  isoCountrySchema,
  languageCodeSchema,
  metricSourceSchema,
  moneySchema,
  nicheTagSchema,
  objectIdSchema,
  platformSchema,
  postFormatSchema,
  sha256Schema,
} from './common.js';
import { fieldConfidenceSchema, metricKeySchema, postMetricsSchema } from './metrics.js';

/* ------------------------------------------------------------------ Creator */

export const creatorHandleSchema = z.object({
  platform: platformSchema,
  handle: handleSchema,
  platformUserId: z.string().min(1).max(64).nullable().default(null),
  profileUrl: httpUrlSchema.nullable().default(null),
});

export const followerSnapshotSchema = z.object({
  platform: platformSchema,
  count: z.number().int().nonnegative().max(10_000_000_000),
  capturedAt: z.coerce.date(),
  source: z.enum(['manual', 'screenshot', 'oauth']),
});

export const consentRecordSchema = z.object({
  grantedAt: z.coerce.date(),
  scopeVersion: z.string().min(1).max(32),
  documentSha256: sha256Schema,
  ipHash: sha256Schema,
  method: z.enum(CONSENT_METHODS),
  withdrawnAt: z.coerce.date().nullable().default(null),
});

export const payoutDetailsSchema = z.object({
  method: z.enum(['bank_transfer', 'paypal', 'gift_only']).nullable().default(null),
  accountRefToken: z.string().max(128).nullable().default(null),
  taxCountry: isoCountrySchema.nullable().default(null),
  verifiedAt: z.coerce.date().nullable().default(null),
});

export const createCreatorSchema = z.object({
  displayName: z.string().min(1).max(120),
  email: z.email().nullable().default(null),
  handles: z.array(creatorHandleSchema).min(1, 'a creator needs at least one platform handle'),
  followerSnapshots: z.array(followerSnapshotSchema).default([]),
  nicheTags: z.array(nicheTagSchema).max(12).default([]),
  country: isoCountrySchema.nullable().default(null),
  city: z.string().max(80).nullable().default(null),
  languages: z.array(languageCodeSchema).max(8).default([]),
  whatsappCommunityId: z.string().max(64).nullable().default(null),
  joinedAt: z.coerce.date().nullable().default(null),
  status: z.enum(CREATOR_STATUSES).default('invited'),
  notes: z.string().max(2000).nullable().default(null),
});

export const updateCreatorSchema = createCreatorSchema.partial();

/* ----------------------------------------------------------------- Campaign */

export const deliverableSpecItemSchema = z.object({
  format: postFormatSchema,
  count: z.number().int().min(1).max(100),
});

export const trackingLinkSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  destinationUrl: httpUrlSchema,
  utmSource: z.string().min(1).max(60),
  utmMedium: z.string().min(1).max(60),
  utmCampaign: z.string().min(1).max(60),
  utmContent: z.string().max(60).nullable().default(null),
  assignedCreatorId: objectIdSchema.nullable().default(null),
  issuedAt: z.coerce.date(),
});

export const discountCodeSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(2).max(40),
  assignedCreatorId: objectIdSchema.nullable().default(null),
  issuedAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable().default(null),
  reportedRedemptions: z.number().int().nonnegative().nullable().default(null),
  reportedRevenue: moneySchema.nullable().default(null),
  reportedAt: z.coerce.date().nullable().default(null),
  reportedBySource: z.string().max(120).nullable().default(null),
});

export const megaBenchmarkSchema = z.object({
  label: z.string().min(1).max(160),
  quotedFee: moneySchema,
  quotedReach: z.number().int().positive(),
  sourceNote: z.string().min(1, 'say where this figure came from').max(400),
  enteredAt: z.coerce.date(),
  enteredByOperatorId: objectIdSchema,
});

export const createCampaignSchema = z
  .object({
    brandId: objectIdSchema,
    name: z.string().min(1).max(140),
    brief: z.string().max(8000).default(''),
    objective: z.string().max(400).default(''),
    status: z.enum(CAMPAIGN_STATUSES).default('draft'),
    platforms: z.array(platformSchema).min(1),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    deliverableSpec: z.array(deliverableSpecItemSchema).min(1),
    compensationModel: z.enum(COMPENSATION_MODELS),
    currency: currencyCodeSchema,
    budgetTotal: moneySchema,
    defaultPerCreatorRate: moneySchema,
    megaBenchmark: megaBenchmarkSchema.nullable().default(null),
  })
  .refine((c) => c.endDate.getTime() > c.startDate.getTime(), {
    message: 'endDate must be after startDate',
    path: ['endDate'],
  })
  .refine((c) => c.budgetTotal.currency === c.currency, {
    message: 'budgetTotal currency must match the campaign currency',
    path: ['budgetTotal', 'currency'],
  })
  .refine((c) => c.defaultPerCreatorRate.currency === c.currency, {
    message: 'defaultPerCreatorRate currency must match the campaign currency',
    path: ['defaultPerCreatorRate', 'currency'],
  });

/* --------------------------------------------------------- CampaignCreator */

export const campaignCreatorStatusSchema = z.enum(CAMPAIGN_CREATOR_STATUSES);

export const createCampaignCreatorSchema = z.object({
  campaignId: objectIdSchema,
  creatorId: objectIdSchema,
  status: campaignCreatorStatusSchema.default('invited'),
  agreedRate: moneySchema.nullable().default(null),
  productShipped: z.boolean().default(false),
  trackingNumber: z.string().max(80).nullable().default(null),
  assignedDiscountCodeId: z.string().max(64).nullable().default(null),
  assignedTrackingLinkId: z.string().max(64).nullable().default(null),
});

export const updateCampaignCreatorStatusSchema = z.object({
  status: campaignCreatorStatusSchema,
  note: z.string().max(500).nullable().default(null),
});

/* --------------------------------------------------------------------- Post */

export const metricOverrideSchema = z.object({
  field: metricKeySchema,
  from: z.number().int().nonnegative().nullable(),
  to: z.number().int().nonnegative().nullable(),
  by: z.string().min(1),
  at: z.coerce.date(),
  reason: z.string().max(500).nullable().default(null),
});

export const plausibilityViolationSchema = z.object({
  rule: z.enum([
    'reach_exceeds_follower_multiple',
    'engagement_rate_implausible',
    'impressions_below_reach',
    'engagements_exceed_impressions',
    'metric_negative_or_non_integer',
    'posted_at_in_future',
    'posted_at_before_campaign_start',
  ]),
  message: z.string(),
  fields: z.array(metricKeySchema),
  severity: z.enum(['fail', 'warn']),
  observed: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});

export const plausibilityResultSchema = z.object({
  passed: z.boolean(),
  violations: z.array(plausibilityViolationSchema),
  skipped: z.array(z.object({ rule: z.string(), reason: z.string() })),
});

export const extractionRecordSchema = z.object({
  sourceImageKey: z.string().min(1).max(512),
  sourceImageSha256: sha256Schema,
  extractedAt: z.coerce.date(),
  model: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(32),
  rawResponse: z.string(),
  parseOk: z.boolean(),
  parseError: z.string().nullable().default(null),
  detectedPlatform: z.enum(['instagram', 'tiktok', 'unknown']).nullable().default(null),
  detectedScreenType: z.string().nullable().default(null),
  modelNotes: z.string().max(200).nullable().default(null),
  fieldConfidence: fieldConfidenceSchema,
  plausibility: plausibilityResultSchema,
  status: z.enum(EXTRACTION_STATUSES),
  routingReasons: z.array(z.string()),
  inputTokens: z.number().int().nonnegative().nullable().default(null),
  outputTokens: z.number().int().nonnegative().nullable().default(null),
});

/** What a creator's device sends when submitting a post. Deliberately tiny. */
export const creatorPostSubmissionSchema = z.object({
  campaignId: objectIdSchema,
  platform: platformSchema,
  format: postFormatSchema,
  publicUrl: httpUrlSchema.nullable().default(null),
  postedAt: z.coerce.date(),
  /** S3 key returned by the presign step. The image itself never hits our API. */
  sourceImageKey: z.string().min(1).max(512),
  sourceImageSha256: sha256Schema,
  caption: z.string().max(2200).nullable().default(null),
});

/** The operator's edit in the verification queue. */
export const verifyPostSchema = z.object({
  metrics: postMetricsSchema,
  decision: z.enum(['verify', 'reject']),
  rejectedReason: z.string().max(500).nullable().default(null),
  overrideReasons: z.partialRecord(metricKeySchema, z.string().max(500)).default({}),
  creativeAngleTags: z.array(nicheTagSchema).max(8).default([]),
  hookText: z.string().max(300).nullable().default(null),
}).refine((v) => v.decision !== 'reject' || (v.rejectedReason?.length ?? 0) > 0, {
  message: 'a rejection must carry a reason',
  path: ['rejectedReason'],
});

export const createPostSchema = z.object({
  creatorId: objectIdSchema,
  campaignId: objectIdSchema,
  platform: platformSchema,
  format: postFormatSchema,
  publicUrl: httpUrlSchema.nullable().default(null),
  postedAt: z.coerce.date(),
  caption: z.string().max(2200).nullable().default(null),
  creativeAngleTags: z.array(nicheTagSchema).max(8).default([]),
  hookText: z.string().max(300).nullable().default(null),
  metrics: postMetricsSchema,
  metricSource: metricSourceSchema,
});

/* ------------------------------------------------------------------- Access */

export const bulkInviteSchema = z.object({
  creatorIds: z.array(objectIdSchema).min(1).max(500),
  campaignId: objectIdSchema.nullable().default(null),
  expiresInDays: z.number().int().min(1).max(90).default(30),
});

export const createShareLinkSchema = z.object({
  campaignId: objectIdSchema,
  label: z.string().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});

export const magicLinkTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'expected a 32-byte base64url token');

export const METRIC_KEY_LIST = METRIC_KEYS;
