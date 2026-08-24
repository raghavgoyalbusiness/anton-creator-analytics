import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  byCreativeAngle,
  byFormat,
  byNiche,
  compareToBenchmark,
  engagementRate,
  isReportable,
  provenanceLabel,
  summariseCampaign,
  summariseConversions,
  topHooks,
  totalEngagements,
  type Money,
  type PostMetrics,
  type ReportCreator,
  type ReportPost,
} from '@anton/shared';
import {
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  PostModel,
  ShareLinkModel,
} from '../db/models/index.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { hashToken, looksLikeToken, mintToken } from '../lib/tokens.js';
import { getOperator } from '../lib/operator-session.js';
import { loadEnv } from '../config/env.js';
import { hashIp } from '../config/consent.js';
import { clientIp, userAgentOf } from '../lib/creator-session.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { getStorage } from '../storage/index.js';
import { READ_URL_TTL_SECONDS } from '../storage/types.js';
import { bandFor } from './operator-roster.js';

export const shareRouter: Router = Router();

/**
 * The brand-facing report.
 *
 * Unauthenticated by design — a brand should not need an account to read a
 * report — but an unguessable URL is obscurity, not access control, so every
 * link carries a mandatory expiry, is revocable instantly, logs every view, and
 * can require an emailed one-time code before showing anything.
 */

/** One-time codes for the email gate. In memory: they live for minutes. */
const emailCodes = new Map<string, { code: string; email: string; expiresAt: number }>();

function pruneCodes(): void {
  const now = Date.now();
  for (const [key, value] of emailCodes) {
    if (value.expiresAt < now) emailCodes.delete(key);
  }
}

async function resolveShareLink(rawToken: string) {
  if (!looksLikeToken(rawToken)) {
    throw ApiError.notFound('invalid_link', 'This report link is not valid.');
  }
  const link = await ShareLinkModel.findOne({ tokenHash: hashToken(rawToken) });
  if (!link) throw ApiError.notFound('invalid_link', 'This report link is not valid.');
  if (link.revokedAt) {
    throw ApiError.gone('link_revoked', 'This report link has been withdrawn.');
  }
  if (link.expiresAt.getTime() <= Date.now()) {
    throw ApiError.gone('link_expired', 'This report link has expired. Ask Anton for a new one.');
  }
  return link;
}

/* ------------------------------------------------------------- email gate */

const requestCodeSchema = z.object({ email: z.email() });

shareRouter.post(
  '/:token/request-code',
  asyncRoute(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string') throw ApiError.notFound('invalid_link', 'Not a valid link.');
    const body = parseBody(requestCodeSchema, req);
    const link = await resolveShareLink(token);

    await enforceRateLimit(
      { bucket: 'share_code_ip', subject: hashIp(clientIp(req)), limit: 10, windowMs: HOUR_MS },
      'Too many code requests. Try again later.',
    );

    pruneCodes();
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const key = `${link._id.toString()}:${body.email.toLowerCase()}`;
    emailCodes.set(key, { code, email: body.email.toLowerCase(), expiresAt: Date.now() + 10 * 60_000 });

    // Delivery is wired in step 7. Logged rather than silently dropped so the
    // gate is testable and its absence is obvious rather than mysterious.
    console.log(`[share] one-time code for ${body.email}: ${code}`);

    res.status(201).json({
      sent: true,
      // Deliberately not revealing whether the address is expected: the gate
      // records who opened the report, it is not an access control list.
      message: 'If that address can receive it, a six-digit code is on its way.',
    });
  }),
);

const verifyCodeSchema = z.object({ email: z.email(), code: z.string().length(6) });

shareRouter.post(
  '/:token/verify-code',
  asyncRoute(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string') throw ApiError.notFound('invalid_link', 'Not a valid link.');
    const body = parseBody(verifyCodeSchema, req);
    const link = await resolveShareLink(token);

    await enforceRateLimit(
      { bucket: 'share_verify_ip', subject: hashIp(clientIp(req)), limit: 20, windowMs: HOUR_MS },
      'Too many attempts. Try again later.',
    );

    pruneCodes();
    const key = `${link._id.toString()}:${body.email.toLowerCase()}`;
    const pending = emailCodes.get(key);
    if (!pending || pending.code !== body.code) {
      throw ApiError.unauthorized('bad_code', 'That code is not right, or it has expired.');
    }
    emailCodes.delete(key);

    await ShareLinkModel.updateOne(
      { _id: link._id },
      { $addToSet: { verifiedViewerEmails: body.email.toLowerCase() } },
    );

    res.json({ verified: true, email: body.email.toLowerCase() });
  }),
);

/* ----------------------------------------------------------------- report */

shareRouter.get(
  '/:token',
  asyncRoute(async (req, res) => {
    const token = req.params.token;
    if (typeof token !== 'string') throw ApiError.notFound('invalid_link', 'Not a valid link.');
    const link = await resolveShareLink(token);

    const viewerEmail =
      typeof req.query.email === 'string' ? req.query.email.toLowerCase() : null;

    // The gate: a link marked requireEmailGate reveals nothing until an address
    // has completed the code challenge on it.
    if (link.requireEmailGate) {
      const verified = viewerEmail != null && link.verifiedViewerEmails.includes(viewerEmail);
      if (!verified) {
        res.status(200).json({
          gated: true,
          campaignName: null,
          message: 'Enter your email to receive a code and open this report.',
        });
        return;
      }
    }

    const campaign = await CampaignModel.findById(link.campaignId).lean();
    if (!campaign) throw ApiError.notFound('campaign_not_found', 'That campaign no longer exists.');
    const brand = await BrandModel.findById(campaign.brandId).lean();

    const [joins, posts] = await Promise.all([
      CampaignCreatorModel.find({ campaignId: campaign._id }).lean(),
      PostModel.find({ campaignId: campaign._id }).lean(),
    ]);

    const creatorDocs = await CreatorModel.find({
      _id: { $in: joins.map((j) => j.creatorId) },
    }).lean();

    const reportPosts: ReportPost[] = posts.map((p) => ({
      postId: p._id.toString(),
      creatorId: p.creatorId.toString(),
      format: p.format,
      platform: p.platform,
      postedAt: p.postedAt,
      metrics: p.metrics as PostMetrics,
      creativeAngleTags: p.creativeAngleTags,
      hookText: p.hookText ?? null,
      metricSource: p.metricSource,
      extractionStatus: p.extraction?.status ?? null,
    }));

    const reportCreators: ReportCreator[] = creatorDocs.map((c) => {
      const join = joins.find((j) => String(j.creatorId) === String(c._id));
      const latest = (c.followerSnapshots ?? []).slice(-1)[0];
      return {
        creatorId: c._id.toString(),
        displayName: c.displayName,
        handle: c.handles[0]?.handle ?? null,
        nicheTags: c.nicheTags,
        followerBand: bandFor(latest?.count ?? null),
        followers: latest?.count ?? null,
        agreedRate: (join?.agreedRate as Money | null) ?? null,
      };
    });

    // Spend is what was actually agreed with the creators who took part, not
    // the campaign budget: an underspent campaign must not look more efficient
    // than it was, and an overspent one must not look cheaper.
    const spendMinor = joins.reduce((sum, j) => sum + (j.agreedRate?.amountMinor ?? 0), 0);
    const spend: Money = { amountMinor: spendMinor, currency: campaign.currency };

    const activated = joins
      .filter((j) => ['accepted', 'shipped', 'posted', 'reported', 'paid'].includes(j.status))
      .map((j) => j.creatorId.toString());

    const summary = summariseCampaign(reportPosts, spend, activated);
    const comparison = compareToBenchmark(
      summary,
      campaign.megaBenchmark
        ? {
            label: campaign.megaBenchmark.label,
            sourceNote: campaign.megaBenchmark.sourceNote,
            enteredAt: campaign.megaBenchmark.enteredAt,
            quotedFee: campaign.megaBenchmark.quotedFee as Money,
            quotedReach: campaign.megaBenchmark.quotedReach,
          }
        : null,
    );

    const storage = getStorage();

    // Per-creator rows. Every row carries a link to the source screenshot: the
    // provenance chain is the differentiator and is built into the payload, not
    // bolted on.
    const rows = await Promise.all(
      reportCreators.map(async (creator) => {
        const mine = reportPosts.filter((p) => p.creatorId === creator.creatorId && isReportable(p));

        const postRows = await Promise.all(
          mine.map(async (p) => {
            const doc = posts.find((x) => x._id.toString() === p.postId);
            const key = doc?.extraction?.sourceImageKey;
            const screenshot = key ? await storage.presignRead(key, READ_URL_TTL_SECONDS) : null;
            const provenance = provenanceLabel(p.metricSource);
            return {
              postId: p.postId,
              format: p.format,
              platform: p.platform,
              postedAt: p.postedAt,
              publicUrl: doc?.publicUrl ?? null,
              metrics: p.metrics,
              engagementRate: engagementRate(p.metrics).value,
              engagements: totalEngagements(p.metrics).value,
              hookText: p.hookText,
              creativeAngleTags: p.creativeAngleTags,
              provenance,
              sourceScreenshotUrl: screenshot?.url ?? null,
              sourceScreenshotExpiresAt: screenshot?.expiresAt ?? null,
              sourceImageSha256: doc?.extraction?.sourceImageSha256 ?? null,
              verifiedAt: doc?.verifiedAt ?? null,
            };
          }),
        );

        const reachValues = mine.map((p) => p.metrics.reach).filter((v): v is number => v !== null);
        const engagementValues = mine
          .map((p) => totalEngagements(p.metrics).value)
          .filter((v): v is number => v !== null);

        return {
          creatorId: creator.creatorId,
          // Anonymisation is per link. When a brand might poach the roster,
          // the operator can show niche and size instead of a handle.
          displayName: link.showCreatorHandles ? creator.displayName : 'Creator',
          handle: link.showCreatorHandles ? creator.handle : null,
          nicheTags: creator.nicheTags,
          followerBand: creator.followerBand,
          followers: link.showCreatorHandles ? creator.followers : null,
          // Off by default. A brand does not need per-creator rates to read a
          // performance report.
          agreedRate: link.showCompensation ? creator.agreedRate : null,
          posts: postRows,
          totalReach: reachValues.length > 0 ? reachValues.reduce((a, b) => a + b, 0) : null,
          totalEngagements:
            engagementValues.length > 0 ? engagementValues.reduce((a, b) => a + b, 0) : null,
        };
      }),
    );

    const conversions = summariseConversions(
      campaign.discountCodes.map((c) => ({
        reportedRedemptions: c.reportedRedemptions ?? null,
        reportedRevenue: (c.reportedRevenue as Money | null) ?? null,
        reportedBySource: c.reportedBySource ?? null,
        reportedAt: c.reportedAt ?? null,
      })),
      campaign.currency,
    );

    // Log the view. Capped so a link that gets shared widely does not grow the
    // document without bound.
    const now = new Date();
    await ShareLinkModel.updateOne({ _id: link._id }, [
      {
        $set: {
          viewCount: { $add: ['$viewCount', 1] },
          lastViewedAt: now,
          views: {
            $slice: [
              {
                $concatArrays: [
                  '$views',
                  [
                    {
                      at: now,
                      ipHash: hashIp(clientIp(req)),
                      userAgent: userAgentOf(req),
                      viewerEmail: viewerEmail,
                    },
                  ],
                ],
              },
              -500,
            ],
          },
        },
      },
    ]);

    await recordAudit({
      actorKind: 'system',
      actorLabel: viewerEmail ?? 'anonymous brand viewer',
      action: AUDIT.shareLinkViewed,
      subjectKind: 'ShareLink',
      subjectId: link._id,
      detail: { campaignId: campaign._id.toString(), viewerEmail },
      ipHash: hashIp(clientIp(req)),
    });

    // Belt and braces with the app-level header: a report must never be indexed.
    res.setHeader('x-robots-tag', 'noindex, nofollow, noarchive, nosnippet');
    res.setHeader('cache-control', 'private, no-store');

    res.json({
      gated: false,
      brand: brand ? { name: brand.name, primaryColorHex: brand.primaryColorHex } : null,
      campaign: {
        name: campaign.name,
        objective: campaign.objective,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        currency: campaign.currency,
      },
      summary,
      comparison,
      creators: rows,
      breakdowns: {
        byCreativeAngle: byCreativeAngle(reportPosts),
        byFormat: byFormat(reportPosts),
        byNiche: byNiche(reportPosts, reportCreators),
      },
      topHooks: topHooks(reportPosts),
      conversions,
      /**
       * The methodology note. Kept server-side so the report cannot be rendered
       * without it, and phrased to say exactly what these numbers are.
       */
      methodology: {
        provenance:
          'Every figure here comes from a screenshot the creator took of their own Instagram or TikTok Insights panel. Anton reads the numbers from that image and a person checks anything uncertain before it appears here. Click any row to see the screenshot a number came from.',
        verificationLimit:
          'These are creator-reported figures with a source image attached, not platform-verified figures. A screenshot can be edited. Anton cross-checks against each creator’s own history, flags implausible values, and spot-audits a random sample by live screen share.',
        exclusions: `${summary.coverage.included} posts are included. ${summary.coverage.excludedNotVerified} are still being checked and ${summary.coverage.excludedRejected} were rejected; neither is counted as zero.`,
        spend:
          'Spend is the total agreed with the creators who took part, not the campaign budget.',
      },
      link: { expiresAt: link.expiresAt, showsCompensation: link.showCompensation },
    });
  }),
);

/* ---------------------------------------------------- operator management */

export const shareAdminRouter: Router = Router();

const createShareSchema = z.object({
  campaignId: z.string().regex(/^[a-f0-9]{24}$/i),
  label: z.string().min(1).max(120),
  expiresInDays: z.number().int().min(1).max(365).default(30),
  showCompensation: z.boolean().default(false),
  showCreatorHandles: z.boolean().default(true),
  requireEmailGate: z.boolean().default(false),
});

shareAdminRouter.post(
  '/share-links',
  asyncRoute(async (req, res) => {
    const body = parseBody(createShareSchema, req);
    const { operator } = getOperator(req);

    const campaign = await CampaignModel.findById(body.campaignId).lean();
    if (!campaign) throw ApiError.notFound('campaign_not_found', 'No such campaign.');

    const { raw, hash } = mintToken();
    const now = new Date();

    // A link showing rates always requires the email gate. Compensation is the
    // most sensitive thing in the report and an unguessable URL is not enough
    // on its own to carry it.
    const requireEmailGate = body.requireEmailGate || body.showCompensation;

    const link = await ShareLinkModel.create({
      tokenHash: hash,
      campaignId: campaign._id,
      label: body.label,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + body.expiresInDays * 86_400_000),
      showCompensation: body.showCompensation,
      showCreatorHandles: body.showCreatorHandles,
      requireEmailGate,
      issuedByOperatorId: operator._id,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.shareLinkCreated,
      subjectKind: 'ShareLink',
      subjectId: link._id,
      detail: {
        campaignId: campaign._id.toString(),
        showCompensation: body.showCompensation,
        showCreatorHandles: body.showCreatorHandles,
        requireEmailGate,
        expiresInDays: body.expiresInDays,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json({
      id: link._id.toString(),
      // Shown once.
      url: `${loadEnv().WEB_ORIGIN}/r/${raw}`,
      expiresAt: link.expiresAt,
      requireEmailGate,
      note: requireEmailGate && body.showCompensation
        ? 'The email gate was switched on automatically because this link shows creator rates.'
        : null,
    });
  }),
);

shareAdminRouter.get(
  '/share-links',
  asyncRoute(async (req, res) => {
    const campaignId = typeof req.query.campaignId === 'string' ? req.query.campaignId : null;
    const filter = campaignId ? { campaignId } : {};
    const links = await ShareLinkModel.find(filter).sort({ issuedAt: -1 }).lean();

    res.json({
      links: links.map((l) => ({
        id: l._id.toString(),
        label: l.label,
        campaignId: l.campaignId.toString(),
        issuedAt: l.issuedAt,
        expiresAt: l.expiresAt,
        revokedAt: l.revokedAt,
        showCompensation: l.showCompensation,
        showCreatorHandles: l.showCreatorHandles,
        requireEmailGate: l.requireEmailGate,
        viewCount: l.viewCount,
        lastViewedAt: l.lastViewedAt,
        // Who opened it and when, so the operator can see where a report went.
        recentViews: l.views.slice(-25).map((v) => ({
          at: v.at,
          viewerEmail: v.viewerEmail,
          // The hash, never the address itself.
          ipHash: v.ipHash.slice(0, 12),
        })),
      })),
    });
  }),
);

shareAdminRouter.post(
  '/share-links/:linkId/revoke',
  asyncRoute(async (req, res) => {
    const linkId = req.params.linkId;
    if (typeof linkId !== 'string' || !/^[a-f0-9]{24}$/i.test(linkId)) {
      throw ApiError.badRequest('bad_id', 'Not a valid link id.');
    }
    const { operator } = getOperator(req);

    const updated = await ShareLinkModel.updateOne(
      { _id: linkId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    if (updated.matchedCount === 0) {
      throw ApiError.notFound('not_found', 'No such live link.');
    }

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.shareLinkRevoked,
      subjectKind: 'ShareLink',
      subjectId: new Types.ObjectId(linkId),
      detail: { linkId },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ revoked: true });
  }),
);

/** Test-only. */
export function peekEmailCode(linkId: string, email: string): string | undefined {
  return emailCodes.get(`${linkId}:${email.toLowerCase()}`)?.code;
}
