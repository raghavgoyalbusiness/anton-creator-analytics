import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { issueTrackingAssetSchema, objectIdSchema } from '@anton/shared';
import { TrackingAssetModel, LinkClickModel, assetIsActive } from '../db/models/TrackingAsset.js';
import { CreatorModel } from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/validate.js';
import { recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp, userAgentOf } from '../lib/creator-session.js';
import { HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import {
  issueTrackingAsset,
  shortLinkUrl,
  userAgentFamily,
  visitorHash,
} from '../tracking/issue.js';

/* ------------------------------------------------------- operator surface */

export const trackingRouter: Router = Router();
trackingRouter.use(requireOperator);

trackingRouter.post(
  '/tracking-assets',
  asyncRoute(async (req, res) => {
    const body = parseBody(issueTrackingAssetSchema, req);
    const { operator } = getOperator(req);

    const asset = await issueTrackingAsset({
      campaignCreatorId: body.campaignCreatorId,
      type: body.type,
      codeStub: body.codeStub,
      destinationUrl: body.destinationUrl,
      commissionRateBps: body.commissionRateBps,
      commissionRateBasis: body.commissionRateBasis,
      activeFrom: body.activeFrom,
      activeUntil: body.activeUntil,
      issuedByOperatorId: operator._id,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: 'tracking_asset.issued',
      subjectKind: 'TrackingAsset',
      subjectId: asset._id,
      detail: {
        type: asset.type,
        campaignId: asset.campaignId.toString(),
        creatorId: asset.creatorId.toString(),
        rateBps: asset.commissionRateBps,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json(serialiseAsset(asset));
  }),
);

const listQuerySchema = z.object({
  campaignId: objectIdSchema.optional(),
  campaignCreatorId: objectIdSchema.optional(),
  status: z.enum(['active', 'expired', 'revoked', 'all']).default('active'),
});

trackingRouter.get(
  '/tracking-assets',
  asyncRoute(async (req, res) => {
    const query = parseQuery(listQuerySchema, req);
    const filter: Record<string, unknown> = {};
    if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);
    if (query.campaignCreatorId) {
      filter.campaignCreatorId = new Types.ObjectId(query.campaignCreatorId);
    }
    if (query.status !== 'all') filter.status = query.status;

    const assets = await TrackingAssetModel.find(filter).sort({ issuedAt: -1 }).lean();
    const creators = await CreatorModel.find({ _id: { $in: assets.map((a) => a.creatorId) } })
      .select('displayName handles')
      .lean();

    const clickCounts = await LinkClickModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $match: { trackingAssetId: { $in: assets.map((a) => a._id) } } },
      { $group: { _id: '$trackingAssetId', n: { $sum: 1 } } },
    ]);

    res.json({
      assets: assets.map((a) => ({
        ...serialiseAsset(a),
        creator: (() => {
          const c = creators.find((x) => String(x._id) === String(a.creatorId));
          return c
            ? { displayName: c.displayName, handle: c.handles[0]?.handle ?? null }
            : null;
        })(),
        clicks: clickCounts.find((c) => String(c._id) === String(a._id))?.n ?? 0,
      })),
    });
  }),
);

const revokeSchema = z.object({ reason: z.string().min(1, 'say why').max(400) });

trackingRouter.post(
  '/tracking-assets/:assetId/revoke',
  asyncRoute(async (req, res) => {
    const assetId = req.params.assetId;
    if (typeof assetId !== 'string' || !/^[a-f0-9]{24}$/i.test(assetId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid asset id.');
    }
    const body = parseBody(revokeSchema, req);
    const { operator } = getOperator(req);

    /**
     * Revoked, never deleted.
     *
     * Orders already attributed through this code keep pointing at it, and a
     * report rendered next year still has to explain where a number came from.
     */
    const updated = await TrackingAssetModel.findOneAndUpdate(
      { _id: assetId, revokedAt: null },
      { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: body.reason } },
      { new: true },
    );
    if (!updated) throw ApiError.notFound('not_found', 'No such live asset.');

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: 'tracking_asset.revoked',
      subjectKind: 'TrackingAsset',
      subjectId: updated._id,
      detail: { reason: body.reason, value: updated.value },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(serialiseAsset(updated));
  }),
);

interface SerialisableAsset {
  _id: Types.ObjectId;
  type: string;
  value: string;
  shortCode?: string | null | undefined;
  destinationUrl?: string | null | undefined;
  campaignId: Types.ObjectId;
  creatorId: Types.ObjectId;
  campaignCreatorId: Types.ObjectId;
  issuedAt: Date;
  activeFrom: Date;
  activeUntil?: Date | null | undefined;
  status: string;
  commissionRateBps: number;
  commissionRateBasis: string;
  revokedAt?: Date | null | undefined;
  revokedReason?: string | null | undefined;
}

function serialiseAsset(a: SerialisableAsset): Record<string, unknown> {
  return {
    id: a._id.toString(),
    type: a.type,
    value: a.value,
    shortCode: a.shortCode ?? null,
    shareUrl: a.shortCode ? shortLinkUrl(a.shortCode) : null,
    destinationUrl: a.destinationUrl ?? null,
    campaignId: a.campaignId.toString(),
    creatorId: a.creatorId.toString(),
    campaignCreatorId: a.campaignCreatorId.toString(),
    issuedAt: a.issuedAt,
    activeFrom: a.activeFrom,
    activeUntil: a.activeUntil ?? null,
    status: a.status,
    commissionRateBps: a.commissionRateBps,
    commissionRateBasis: a.commissionRateBasis,
    revokedAt: a.revokedAt ?? null,
    revokedReason: a.revokedReason ?? null,
  };
}

/* --------------------------------------------------------- public redirect */

export const redirectRouter: Router = Router();

/**
 * The short-link redirect.
 *
 * Public, unauthenticated, and hit by members of the public who have no
 * relationship with Anton. Two consequences run through everything below: it
 * records the minimum needed to join a click to an order and nothing more, and
 * it never fails in a way that strands the visitor — a tracking failure sends
 * them to the shop anyway.
 */
redirectRouter.get(
  '/t/:shortCode',
  asyncRoute(async (req, res) => {
    const shortCode = req.params.shortCode;
    if (typeof shortCode !== 'string' || !/^[A-Z0-9]{4,16}$/i.test(shortCode)) {
      res.status(404).type('text/plain').send('Unknown link.');
      return;
    }

    const asset = await TrackingAssetModel.findOne({ shortCode: shortCode.toUpperCase() }).lean();
    if (!asset || !asset.destinationUrl) {
      res.status(404).type('text/plain').send('Unknown link.');
      return;
    }

    const now = new Date();
    const active = assetIsActive(asset, now);

    // Rate limited per visitor so a bot cannot inflate a creator's click count.
    // Failure to record must never block the redirect.
    if (active) {
      const ip = clientIp(req);
      const ua = userAgentOf(req);
      const hash = visitorHash(ip, ua, now);

      const verdict = await enforceRateLimit(
        { bucket: 'link_click', subject: `${hash}:${asset._id.toString()}`, limit: 20, windowMs: HOUR_MS },
        'Too many clicks.',
      ).catch(() => null);

      if (verdict) {
        await LinkClickModel.create({
          trackingAssetId: asset._id,
          campaignCreatorId: asset.campaignCreatorId,
          campaignId: asset.campaignId,
          creatorId: asset.creatorId,
          brandId: asset.brandId,
          clickedAt: now,
          visitorHash: hash,
          userAgentFamily: userAgentFamily(ua),
          referrerHost: safeHost(req.header('referer')),
        }).catch((err: unknown) => {
          console.error('[tracking] click not recorded:', err);
        });
      }
    }

    /**
     * An expired or revoked link still forwards to the shop.
     *
     * The visitor did nothing wrong and a dead end costs the brand a sale. The
     * click simply is not recorded, so no commission accrues from it.
     */
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.redirect(302, active ? asset.value : asset.destinationUrl);
  }),
);

function safeHost(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).hostname.slice(0, 120);
  } catch {
    return null;
  }
}
