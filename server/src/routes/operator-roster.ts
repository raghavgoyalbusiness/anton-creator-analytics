import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  engagementRate,
  followerCountAsOf,
  nicheTagSchema,
  objectIdSchema,
  platformSchema,
  type Platform,
  type PostMetrics,
} from '@anton/shared';
import {
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  MagicLinkModel,
  PostModel,
} from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { mintToken } from '../lib/tokens.js';
import { loadEnv } from '../config/env.js';
import { HOUR_MS } from '../lib/rate-limit.js';

export const operatorRosterRouter: Router = Router();
operatorRosterRouter.use(requireOperator);

/** Follower bands, used for filtering and for anonymised brand reports. */
export const FOLLOWER_BANDS = [
  { key: 'nano', label: 'Nano (under 5k)', min: 0, max: 4_999 },
  { key: 'micro_small', label: 'Micro (5k–20k)', min: 5_000, max: 19_999 },
  { key: 'micro_large', label: 'Micro (20k–60k)', min: 20_000, max: 59_999 },
  { key: 'mid', label: 'Mid (60k+)', min: 60_000, max: Number.MAX_SAFE_INTEGER },
] as const;

export function bandFor(count: number | null): string {
  if (count === null) return 'unknown';
  return FOLLOWER_BANDS.find((b) => count >= b.min && count <= b.max)?.key ?? 'unknown';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1];
  const hi = sorted[mid];
  return lo !== undefined && hi !== undefined ? (lo + hi) / 2 : null;
}

/* ------------------------------------------------------------------ roster */

const rosterQuerySchema = z.object({
  niche: z.string().max(40).optional(),
  platform: platformSchema.optional(),
  band: z.string().max(20).optional(),
  status: z.enum(['invited', 'active', 'paused', 'removed', 'all']).default('all'),
  campaignId: objectIdSchema.optional(),
  search: z.string().max(80).optional(),
  sort: z.enum(['name', 'followers', 'engagement', 'posts']).default('followers'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * The roster.
 *
 * Median engagement rate rather than mean: one viral post would otherwise drag
 * a creator's headline number somewhere it does not belong, and the whole point
 * of this view is comparing creators fairly.
 *
 * Only brand-reportable posts feed the median. A number an operator has not
 * signed off should not influence who gets picked for the next campaign.
 */
operatorRosterRouter.get(
  '/roster',
  asyncRoute(async (req, res) => {
    const query = parseQuery(rosterQuerySchema, req);

    const filter: Record<string, unknown> = {};
    if (query.status !== 'all') filter.status = query.status;
    else filter.status = { $ne: 'removed' };
    if (query.niche) filter.nicheTags = query.niche;
    if (query.platform) filter['handles.platform'] = query.platform;
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { displayName: { $regex: escaped, $options: 'i' } },
        { 'handles.handle': { $regex: escaped, $options: 'i' } },
      ];
    }

    let creators = await CreatorModel.find(filter).limit(query.limit).lean();

    if (query.campaignId) {
      const joins = await CampaignCreatorModel.find({
        campaignId: new Types.ObjectId(query.campaignId),
      })
        .select('creatorId')
        .lean();
      const onCampaign = new Set(joins.map((j) => String(j.creatorId)));
      creators = creators.filter((c) => onCampaign.has(String(c._id)));
    }

    const creatorIds = creators.map((c) => c._id);
    const [posts, joins] = await Promise.all([
      PostModel.find({
        creatorId: { $in: creatorIds },
        'extraction.status': { $in: ['auto_accepted', 'verified'] },
      })
        .select('creatorId metrics postedAt platform')
        .lean(),
      CampaignCreatorModel.find({ creatorId: { $in: creatorIds } })
        .select('creatorId campaignId status')
        .lean(),
    ]);

    const rows = creators.map((creator) => {
      const mine = posts.filter((p) => String(p.creatorId) === String(creator._id));
      const rates = mine
        .map((p) => engagementRate(p.metrics as PostMetrics).value)
        .filter((r): r is number => r !== null);

      const platform = (creator.handles[0]?.platform ?? 'instagram') as Platform;
      const latest = followerCountAsOf(
        (creator.followerSnapshots ?? []).map((s) => ({
          platform: s.platform as Platform,
          count: s.count,
          capturedAt: s.capturedAt,
          source: s.source as 'manual' | 'screenshot' | 'oauth',
        })),
        platform,
        new Date(),
      );

      const myJoins = joins.filter((j) => String(j.creatorId) === String(creator._id));

      return {
        id: creator._id.toString(),
        displayName: creator.displayName,
        handles: creator.handles.map((h) => ({ platform: h.platform, handle: h.handle })),
        status: creator.status,
        nicheTags: creator.nicheTags,
        country: creator.country,
        city: creator.city,
        languages: creator.languages,
        followers: latest?.count ?? null,
        followersCapturedAt: latest?.capturedAt ?? null,
        followerBand: bandFor(latest?.count ?? null),
        hasConsent: creator.consent != null && creator.consent.withdrawnAt == null,
        // null, not zero: a creator with no reportable posts has no measured
        // engagement rate, which is a different thing from a rate of zero.
        medianEngagementRate: median(rates),
        reportablePosts: mine.length,
        campaignsJoined: myJoins.length,
        campaignsCompleted: myJoins.filter((j) => ['reported', 'paid'].includes(j.status)).length,
        lastPostedAt:
          mine.length > 0
            ? mine.reduce((a, b) => (a.postedAt > b.postedAt ? a : b)).postedAt
            : null,
      };
    });

    const filtered = query.band ? rows.filter((r) => r.followerBand === query.band) : rows;

    filtered.sort((a, b) => {
      switch (query.sort) {
        case 'name':
          return a.displayName.localeCompare(b.displayName);
        case 'engagement':
          // Creators with no measured rate sort last rather than as zero.
          return (b.medianEngagementRate ?? -1) - (a.medianEngagementRate ?? -1);
        case 'posts':
          return b.reportablePosts - a.reportablePosts;
        default:
          return (b.followers ?? -1) - (a.followers ?? -1);
      }
    });

    res.json({
      creators: filtered,
      bands: FOLLOWER_BANDS,
      niches: [...new Set(rows.flatMap((r) => r.nicheTags))].sort(),
      total: filtered.length,
    });
  }),
);

/* --------------------------------------------------------------- campaigns */

operatorRosterRouter.get(
  '/campaigns',
  asyncRoute(async (_req, res) => {
    const campaigns = await CampaignModel.find({}).sort({ startDate: -1 }).lean();
    const counts = await CampaignCreatorModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $group: { _id: '$campaignId', n: { $sum: 1 } } },
    ]);
    const postCounts = await PostModel.aggregate<{ _id: Types.ObjectId; n: number }>([
      { $group: { _id: '$campaignId', n: { $sum: 1 } } },
    ]);

    res.json({
      campaigns: campaigns.map((c) => ({
        id: c._id.toString(),
        brandId: c.brandId.toString(),
        name: c.name,
        status: c.status,
        objective: c.objective,
        platforms: c.platforms,
        startDate: c.startDate,
        endDate: c.endDate,
        compensationModel: c.compensationModel,
        currency: c.currency,
        budgetTotal: c.budgetTotal,
        defaultPerCreatorRate: c.defaultPerCreatorRate,
        deliverableSpec: c.deliverableSpec,
        hasBenchmark: c.megaBenchmark != null,
        creators: counts.find((x) => String(x._id) === String(c._id))?.n ?? 0,
        posts: postCounts.find((x) => String(x._id) === String(c._id))?.n ?? 0,
      })),
    });
  }),
);

const benchmarkSchema = z.object({
  label: z.string().min(1).max(160),
  quotedFeeMinor: z.number().int().nonnegative(),
  quotedReach: z.number().int().positive(),
  sourceNote: z.string().min(1, 'say where this figure came from').max(400),
});

/**
 * Sets the mega-influencer comparison figure.
 *
 * `sourceNote` is required, not optional. This number goes in front of a brand
 * as the thing Anton is measured against; a benchmark with no stated provenance
 * is exactly the kind of unsourced assertion this product exists to replace.
 */
operatorRosterRouter.put(
  '/campaigns/:campaignId/benchmark',
  asyncRoute(async (req, res) => {
    const campaignId = req.params.campaignId;
    if (typeof campaignId !== 'string' || !/^[a-f0-9]{24}$/i.test(campaignId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid campaign id.');
    }
    const body = parseBody(benchmarkSchema, req);
    const { operator } = getOperator(req);

    const campaign = await CampaignModel.findById(campaignId);
    if (!campaign) throw ApiError.notFound('campaign_not_found', 'No such campaign.');

    await CampaignModel.updateOne(
      { _id: campaign._id },
      {
        $set: {
          megaBenchmark: {
            label: body.label,
            quotedFee: { amountMinor: body.quotedFeeMinor, currency: campaign.currency },
            quotedReach: body.quotedReach,
            sourceNote: body.sourceNote,
            enteredAt: new Date(),
            enteredByOperatorId: operator._id,
          },
        },
      },
    );

    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------ bulk invite */

const bulkInviteSchema = z.object({
  creatorIds: z.array(objectIdSchema).min(1).max(200),
  campaignId: objectIdSchema.nullable().default(null),
});

/**
 * Mints magic links in bulk for pasting into WhatsApp.
 *
 * The raw tokens exist only in this response. They are short-lived and
 * single-use by policy, which sits awkwardly with pasting a batch into a group
 * chat — a creator who taps theirs an hour later gets an expired link and has
 * to ask for another. The response says so plainly rather than letting the
 * operator discover it from complaints.
 */
operatorRosterRouter.post(
  '/invites',
  asyncRoute(async (req, res) => {
    const body = parseBody(bulkInviteSchema, req);
    const { operator } = getOperator(req);
    const env = loadEnv();

    const creators = await CreatorModel.find({
      _id: { $in: body.creatorIds.map((id) => new Types.ObjectId(id)) },
      status: { $ne: 'removed' },
    }).lean();

    if (creators.length === 0) {
      throw ApiError.badRequest('no_creators', 'None of those creators exist.');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.MAGIC_LINK_TTL_MINUTES * 60_000);

    const issued = creators.map((creator) => {
      const { raw, hash } = mintToken();
      return { creator, raw, hash };
    });

    await MagicLinkModel.insertMany(
      issued.map(({ creator, hash }) => ({
        tokenHash: hash,
        creatorId: creator._id,
        campaignId: body.campaignId ? new Types.ObjectId(body.campaignId) : null,
        issuedAt: now,
        expiresAt,
        issuedByOperatorId: operator._id,
      })),
    );

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.magicLinksIssued,
      detail: { count: issued.length, campaignId: body.campaignId },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json({
      expiresAt,
      ttlMinutes: env.MAGIC_LINK_TTL_MINUTES,
      warning: `These expire in ${env.MAGIC_LINK_TTL_MINUTES} minutes and each works once. Send them when the creator is expecting one, not hours ahead — anyone who taps late will need a fresh link.`,
      links: issued.map(({ creator, raw }) => ({
        creatorId: creator._id.toString(),
        displayName: creator.displayName,
        handle: creator.handles[0]?.handle ?? null,
        // Shown here and nowhere else, ever.
        url: `${env.WEB_ORIGIN}/c/${raw}`,
      })),
    });
  }),
);

/** Cancels every unspent link for a creator, and optionally their sessions. */
operatorRosterRouter.post(
  '/creators/:creatorId/revoke-links',
  asyncRoute(async (req, res) => {
    const creatorId = req.params.creatorId;
    if (typeof creatorId !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const { operator } = getOperator(req);
    const { revokeAllCreatorSessions } = await import('../lib/creator-session.js');

    const links = await MagicLinkModel.updateMany(
      { creatorId: new Types.ObjectId(creatorId), revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    const sessions = await revokeAllCreatorSessions(
      new Types.ObjectId(creatorId),
      'revoked by operator',
    );

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.magicLinksRevoked,
      subjectKind: 'Creator',
      subjectId: new Types.ObjectId(creatorId),
      detail: { linksRevoked: links.modifiedCount, sessionsRevoked: sessions },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ linksRevoked: links.modifiedCount, sessionsRevoked: sessions });
  }),
);

/* -------------------------------------------------------------- one creator */

operatorRosterRouter.get(
  '/creators/:creatorId',
  asyncRoute(async (req, res) => {
    const creatorId = req.params.creatorId;
    if (typeof creatorId !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const { operator } = getOperator(req);

    const creator = await CreatorModel.findById(creatorId).lean();
    if (!creator) throw ApiError.notFound('creator_not_found', 'No such creator.');

    const [posts, joins, links] = await Promise.all([
      PostModel.find({ creatorId: creator._id }).sort({ postedAt: -1 }).lean(),
      CampaignCreatorModel.find({ creatorId: creator._id }).lean(),
      MagicLinkModel.find({ creatorId: creator._id }).sort({ issuedAt: -1 }).limit(20).lean(),
    ]);

    // Reading one creator's full record is itself worth an audit row.
    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.operatorViewedCreator,
      subjectKind: 'Creator',
      subjectId: creator._id,
      ipHash: hashIp(clientIp(req)),
    });

    res.json({
      creator: {
        id: creator._id.toString(),
        displayName: creator.displayName,
        email: creator.email,
        handles: creator.handles,
        followerSnapshots: creator.followerSnapshots,
        nicheTags: creator.nicheTags,
        country: creator.country,
        city: creator.city,
        languages: creator.languages,
        status: creator.status,
        joinedAt: creator.joinedAt,
        consent: creator.consent,
        notes: creator.notes,
      },
      posts: posts.map((p) => ({
        id: p._id.toString(),
        campaignId: p.campaignId.toString(),
        platform: p.platform,
        format: p.format,
        postedAt: p.postedAt,
        status: p.extraction?.status ?? null,
        instructionTextDetected: p.extraction?.instructionTextDetected ?? false,
        metrics: p.metrics,
        overrides: p.manualOverrides.length,
      })),
      participation: joins,
      links: links.map((l) => ({
        issuedAt: l.issuedAt,
        expiresAt: l.expiresAt,
        usedAt: l.usedAt,
        revokedAt: l.revokedAt,
        openCount: l.openCount,
      })),
    });
  }),
);

/* -------------------------------------------------------------- nudge list */

const nudgeQuerySchema = z.object({
  campaignId: objectIdSchema.optional(),
  /** Hours since the stage was entered before someone counts as stuck. */
  thresholdHours: z.coerce.number().int().min(1).max(2_000).default(120),
});

/**
 * Who is stuck, and where.
 *
 * Two distinct groups the brief calls out: accepted but never posted, and
 * posted but never submitted insights. They need different messages, so they
 * are returned separately rather than as one undifferentiated chase list.
 */
operatorRosterRouter.get(
  '/nudges',
  asyncRoute(async (req, res) => {
    const query = parseQuery(nudgeQuerySchema, req);
    const cutoff = new Date(Date.now() - query.thresholdHours * HOUR_MS);

    const filter: Record<string, unknown> = {};
    if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);

    const joins = await CampaignCreatorModel.find(filter).lean();
    const creatorIds = [...new Set(joins.map((j) => String(j.creatorId)))];
    const campaignIds = [...new Set(joins.map((j) => String(j.campaignId)))];

    const [creators, campaigns, posts] = await Promise.all([
      CreatorModel.find({ _id: { $in: creatorIds } }).select('displayName handles status').lean(),
      CampaignModel.find({ _id: { $in: campaignIds } }).select('name endDate').lean(),
      PostModel.find({ creatorId: { $in: creatorIds } }).select('creatorId campaignId').lean(),
    ]);

    const decorate = (join: (typeof joins)[number], reason: string, since: Date | null) => {
      const creator = creators.find((c) => String(c._id) === String(join.creatorId));
      const campaign = campaigns.find((c) => String(c._id) === String(join.campaignId));
      return {
        creatorId: join.creatorId.toString(),
        displayName: creator?.displayName ?? 'Unknown',
        handle: creator?.handles?.[0]?.handle ?? null,
        campaignId: join.campaignId.toString(),
        campaignName: campaign?.name ?? 'Unknown',
        campaignEndsAt: campaign?.endDate ?? null,
        status: join.status,
        reason,
        waitingSince: since,
        daysWaiting: since ? Math.floor((Date.now() - since.getTime()) / 86_400_000) : null,
      };
    };

    const acceptedNotPosted = joins
      .filter((j) => ['accepted', 'shipped'].includes(j.status))
      .filter((j) => {
        const since = j.shippedAt ?? j.respondedAt ?? j.invitedAt;
        return since != null && since <= cutoff;
      })
      .map((j) =>
        decorate(
          j,
          j.status === 'shipped'
            ? 'Product shipped but nothing posted yet.'
            : 'Accepted but nothing posted yet.',
          j.shippedAt ?? j.respondedAt ?? j.invitedAt ?? null,
        ),
      );

    const postedNotSubmitted = joins
      .filter((j) => j.status === 'posted')
      .filter((j) => j.firstPostedAt != null && j.firstPostedAt <= cutoff)
      .filter(
        (j) =>
          !posts.some(
            (p) =>
              String(p.creatorId) === String(j.creatorId) &&
              String(p.campaignId) === String(j.campaignId),
          ),
      )
      .map((j) => decorate(j, 'Posted but has not sent the Insights screenshot.', j.firstPostedAt ?? null));

    const invitedNoReply = joins
      .filter((j) => j.status === 'invited')
      .filter((j) => j.invitedAt != null && j.invitedAt <= cutoff)
      .map((j) => decorate(j, 'Invited but has not replied.', j.invitedAt ?? null));

    res.json({
      thresholdHours: query.thresholdHours,
      acceptedNotPosted,
      postedNotSubmitted,
      invitedNoReply,
      total: acceptedNotPosted.length + postedNotSubmitted.length + invitedNoReply.length,
    });
  }),
);

/* ----------------------------------------------------------- creator edits */

const creatorPatchSchema = z.object({
  nicheTags: z.array(nicheTagSchema).max(12).optional(),
  city: z.string().max(80).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['invited', 'active', 'paused']).optional(),
});

operatorRosterRouter.patch(
  '/creators/:creatorId',
  asyncRoute(async (req, res) => {
    const creatorId = req.params.creatorId;
    if (typeof creatorId !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const body = parseBody(creatorPatchSchema, req);
    const { operator } = getOperator(req);

    const updated = await CreatorModel.findByIdAndUpdate(
      creatorId,
      { $set: body },
      { new: true },
    ).lean();
    if (!updated) throw ApiError.notFound('creator_not_found', 'No such creator.');

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: 'creator.updated',
      subjectKind: 'Creator',
      subjectId: updated._id,
      detail: { fields: Object.keys(body) },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true });
  }),
);

/** Appends a follower snapshot on the creator's behalf. Never overwrites. */
operatorRosterRouter.post(
  '/creators/:creatorId/followers',
  asyncRoute(async (req, res) => {
    const creatorId = req.params.creatorId;
    if (typeof creatorId !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const body = parseBody(
      z.object({ platform: platformSchema, count: z.number().int().nonnegative() }),
      req,
    );

    const updated = await CreatorModel.findByIdAndUpdate(creatorId, {
      $push: {
        followerSnapshots: {
          platform: body.platform,
          count: body.count,
          capturedAt: new Date(),
          source: 'manual',
        },
      },
    });
    if (!updated) throw ApiError.notFound('creator_not_found', 'No such creator.');

    res.status(201).json({ ok: true });
  }),
);
