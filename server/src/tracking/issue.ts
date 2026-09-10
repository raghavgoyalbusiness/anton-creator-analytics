import { randomInt as cryptoRandomInt, createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  buildTrackedUrl,
  drawUniqueCode,
  drawUniqueShortCode,
  normaliseStub,
  normaliseTypedCode,
  type RateBasis,
} from '@anton/shared';
import {
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
} from '../db/models/index.js';
import { TrackingAssetModel, type TrackingAssetDoc } from '../db/models/TrackingAsset.js';
import type { HydratedDocument } from 'mongoose';
import { ApiError } from '../lib/errors.js';
import { loadEnv } from '../config/env.js';

/**
 * Issuing tracking assets.
 *
 * Codes are generated server-side only. A client-supplied code would let an
 * operator (or anything that reached the endpoint) claim a string another
 * brand's checkout already honours.
 */

/** CSPRNG. A guessable discount code is a discount anyone can claim. */
const secureRandomInt = (max: number): number => cryptoRandomInt(max);

export interface IssueParams {
  readonly campaignCreatorId: string;
  readonly type: 'discount_code' | 'tracked_link';
  readonly codeStub?: string | undefined;
  readonly destinationUrl?: string | undefined;
  readonly commissionRateBps: number;
  readonly commissionRateBasis: RateBasis;
  readonly activeFrom?: Date | undefined;
  readonly activeUntil?: Date | null | undefined;
  readonly issuedByOperatorId: Types.ObjectId;
}

export async function issueTrackingAsset(
  params: IssueParams,
): Promise<HydratedDocument<TrackingAssetDoc>> {
  const join = await CampaignCreatorModel.findById(params.campaignCreatorId).lean();
  if (!join) throw ApiError.notFound('join_not_found', 'That creator is not on that campaign.');

  const [campaign, creator] = await Promise.all([
    CampaignModel.findById(join.campaignId).lean(),
    CreatorModel.findById(join.creatorId).lean(),
  ]);
  if (!campaign) throw ApiError.notFound('campaign_not_found', 'No such campaign.');
  if (!creator) throw ApiError.notFound('creator_not_found', 'No such creator.');

  const now = new Date();
  const activeFrom = params.activeFrom ?? now;
  const activeUntil = params.activeUntil ?? campaign.endDate;

  /**
   * One live asset of each type per creator per campaign.
   *
   * Two live codes for the same creator on the same campaign split their own
   * attribution, and neither the creator nor the brand can tell why the
   * numbers look halved.
   */
  const existing = await TrackingAssetModel.findOne({
    campaignCreatorId: join._id,
    type: params.type,
    status: 'active',
  }).lean();
  if (existing) {
    throw ApiError.conflict(
      'asset_already_issued',
      `This creator already has an active ${params.type.replace('_', ' ')} on this campaign. Revoke it first.`,
    );
  }

  if (params.type === 'tracked_link') {
    return issueLink({ params, join, campaign, creator, activeFrom, activeUntil, now });
  }
  return issueCode({ params, join, campaign, creator, activeFrom, activeUntil, now });
}

interface Context {
  params: IssueParams;
  join: { _id: Types.ObjectId; campaignId: Types.ObjectId; creatorId: Types.ObjectId };
  campaign: { _id: Types.ObjectId; brandId: Types.ObjectId; name: string; endDate: Date };
  creator: { displayName: string; handles: { handle: string }[] };
  activeFrom: Date;
  activeUntil: Date | null;
  now: Date;
}

async function issueCode(ctx: Context): Promise<HydratedDocument<TrackingAssetDoc>> {
  // Stub preference: what the operator asked for, else the creator's handle,
  // else their display name. The creator has to recognise it as theirs.
  const rawStub =
    ctx.params.codeStub ?? ctx.creator.handles[0]?.handle ?? ctx.creator.displayName;
  const stub = normaliseStub(rawStub);
  if (stub.length < 2) {
    throw ApiError.badRequest(
      'unusable_stub',
      `Could not build a code prefix from "${rawStub}". Supply one explicitly.`,
    );
  }

  /**
   * Collision check against every code already live for this brand.
   *
   * Loaded once into a set rather than queried per attempt: the unique index is
   * the real guarantee, and this exists so the common case fails in the
   * generator with a readable error rather than as a duplicate-key exception.
   */
  const brandCodes = await TrackingAssetModel.find({
    brandId: ctx.campaign.brandId,
    type: 'discount_code',
  })
    .select('matchKey')
    .lean();
  const taken = new Set(brandCodes.map((a) => a.matchKey));

  const code = drawUniqueCode({
    stub,
    randomInt: secureRandomInt,
    isTaken: (candidate) => taken.has(normaliseTypedCode(candidate)),
  });

  try {
    return await TrackingAssetModel.create({
      campaignCreatorId: ctx.join._id,
      campaignId: ctx.campaign._id,
      creatorId: ctx.join.creatorId,
      brandId: ctx.campaign.brandId,
      type: 'discount_code',
      value: code,
      matchKey: normaliseTypedCode(code),
      shortCode: null,
      destinationUrl: null,
      issuedAt: ctx.now,
      activeFrom: ctx.activeFrom,
      activeUntil: ctx.activeUntil,
      status: 'active',
      commissionRateBps: ctx.params.commissionRateBps,
      commissionRateBasis: ctx.params.commissionRateBasis,
      issuedByOperatorId: ctx.params.issuedByOperatorId,
    });
  } catch (err: unknown) {
    // The index caught a race the in-memory set could not. Surface it as a
    // conflict rather than a 500 — the caller can simply try again.
    if (isDuplicateKey(err)) {
      throw ApiError.conflict(
        'code_collision',
        'That code was taken while it was being issued. Try again.',
      );
    }
    throw err;
  }
}

async function issueLink(ctx: Context): Promise<HydratedDocument<TrackingAssetDoc>> {
  if (!ctx.params.destinationUrl) {
    throw ApiError.badRequest('no_destination', 'A tracked link needs a destination URL.');
  }

  let parsed: URL;
  try {
    parsed = new URL(ctx.params.destinationUrl);
  } catch {
    throw ApiError.badRequest('bad_destination', 'That destination is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw ApiError.badRequest('bad_destination', 'Destinations must be http or https.');
  }

  const existingShort = await TrackingAssetModel.find({ shortCode: { $ne: null } })
    .select('shortCode')
    .lean();
  const takenShort = new Set(existingShort.map((a) => a.shortCode));

  const shortCode = drawUniqueShortCode({
    randomInt: secureRandomInt,
    isTaken: (c) => takenShort.has(c),
  });

  const trackedUrl = buildTrackedUrl({
    destinationUrl: ctx.params.destinationUrl,
    shortCode,
    utmCampaign: slugify(ctx.campaign.name),
    utmContent: ctx.creator.handles[0]?.handle ?? slugify(ctx.creator.displayName),
  });

  try {
    return await TrackingAssetModel.create({
      campaignCreatorId: ctx.join._id,
      campaignId: ctx.campaign._id,
      creatorId: ctx.join.creatorId,
      brandId: ctx.campaign.brandId,
      type: 'tracked_link',
      value: trackedUrl,
      matchKey: shortCode,
      shortCode,
      destinationUrl: ctx.params.destinationUrl,
      issuedAt: ctx.now,
      activeFrom: ctx.activeFrom,
      activeUntil: ctx.activeUntil,
      status: 'active',
      commissionRateBps: ctx.params.commissionRateBps,
      commissionRateBasis: ctx.params.commissionRateBasis,
      issuedByOperatorId: ctx.params.issuedByOperatorId,
    });
  } catch (err: unknown) {
    if (isDuplicateKey(err)) {
      throw ApiError.conflict('short_code_collision', 'Short code collision. Try again.');
    }
    throw err;
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** The public URL a creator shares. */
export function shortLinkUrl(shortCode: string): string {
  return `${loadEnv().WEB_ORIGIN}/t/${shortCode}`;
}

/**
 * A per-visitor identifier for click-to-order joining.
 *
 * Salted with the server secret and bucketed by day, so it cannot be used to
 * follow anyone across the retention period and rotates on its own. It is a
 * join key with a short life, not an identity.
 */
export function visitorHash(ip: string, userAgent: string, at: Date): string {
  const day = at.toISOString().slice(0, 10);
  return createHash('sha256')
    .update(`${loadEnv().IP_HASH_SALT}:${day}:${ip}:${userAgent}`)
    .digest('hex');
}

/** Coarse UA family. Never a fingerprint. */
export function userAgentFamily(ua: string): string | null {
  if (!ua) return null;
  const os = /iPhone|iPad/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Mac OS X/i.test(ua)
        ? 'Mac'
        : /Windows/i.test(ua)
          ? 'Windows'
          : 'Other';
  const browser = /CriOS|Chrome/i.test(ua)
    ? 'Chrome'
    : /FxiOS|Firefox/i.test(ua)
      ? 'Firefox'
      : /Safari/i.test(ua)
        ? 'Safari'
        : 'Other';
  return `${browser} on ${os}`;
}
