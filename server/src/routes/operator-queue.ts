import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  METRIC_KEYS,
  engagementRate,
  followerCountAsOf,
  metricKeySchema,
  objectIdSchema,
  postMetricsSchema,
  totalEngagements,
  type MetricKey,
  type Platform,
  type PostMetrics,
} from '@anton/shared';
import { CampaignModel, CreatorModel, PostModel } from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody, parseQuery } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { getStorage } from '../storage/index.js';
import { READ_URL_TTL_SECONDS } from '../storage/types.js';
import { spendSummary } from '../extraction/spend.js';

export const operatorQueueRouter: Router = Router();
operatorQueueRouter.use(requireOperator);

/**
 * Express 5 types a path param as string | string[]. Narrowing here rather than
 * at each call site keeps the id validation in exactly one place.
 */
function readObjectIdParam(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/i.test(value)) {
    throw ApiError.badRequest('bad_id', `Not a valid ${label}.`);
  }
  return value;
}

/**
 * The verification queue.
 *
 * Built for throughput: the operator works dozens of these in a sitting, so the
 * list endpoint returns everything one screen needs in a single round trip, and
 * decisions are one request each.
 */

/* ------------------------------------------------------------------- list */

const queueQuerySchema = z.object({
  status: z.enum(['needs_review', 'pending', 'auto_accepted', 'verified', 'rejected', 'all']).default('needs_review'),
  campaignId: objectIdSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

operatorQueueRouter.get(
  '/queue',
  asyncRoute(async (req, res) => {
    const query = parseQuery(queueQuerySchema, req);

    const filter: Record<string, unknown> = {};
    if (query.status !== 'all') filter['extraction.status'] = query.status;
    if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);

    // Oldest first: a queue worked newest-first leaves a permanent tail of
    // submissions nobody ever reaches.
    const posts = await PostModel.find(filter).sort({ submittedAt: 1 }).limit(query.limit).lean();

    const creatorIds = [...new Set(posts.map((p) => String(p.creatorId)))];
    const campaignIds = [...new Set(posts.map((p) => String(p.campaignId)))];

    const [creators, campaigns, counts] = await Promise.all([
      CreatorModel.find({ _id: { $in: creatorIds } })
        .select('displayName handles followerSnapshots nicheTags')
        .lean(),
      CampaignModel.find({ _id: { $in: campaignIds } }).select('name startDate').lean(),
      PostModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$extraction.status', n: { $sum: 1 } } },
      ]),
    ]);

    const storage = getStorage();

    const items = await Promise.all(
      posts.map(async (post) => {
        const creator = creators.find((c) => String(c._id) === String(post.creatorId));
        const campaign = campaigns.find((c) => String(c._id) === String(post.campaignId));

        const followerSnapshot = creator
          ? followerCountAsOf(
              (creator.followerSnapshots ?? []).map((s) => ({
                platform: s.platform as Platform,
                count: s.count,
                capturedAt: s.capturedAt,
                source: s.source as 'manual' | 'screenshot' | 'oauth',
              })),
              post.platform,
              post.postedAt,
            )
          : null;

        // Short-lived, generated per request. Never a durable URL.
        const screenshot = post.extraction?.sourceImageKey
          ? await storage.presignRead(post.extraction.sourceImageKey, READ_URL_TTL_SECONDS)
          : null;

        const metrics = post.metrics as PostMetrics;
        const er = engagementRate(metrics);

        return {
          id: post._id.toString(),
          campaign: { id: post.campaignId.toString(), name: campaign?.name ?? 'Unknown', startDate: campaign?.startDate },
          creator: {
            id: post.creatorId.toString(),
            displayName: creator?.displayName ?? 'Unknown',
            handle: creator?.handles?.[0]?.handle ?? null,
            followersAtPost: followerSnapshot?.count ?? null,
            followersCapturedAt: followerSnapshot?.capturedAt ?? null,
          },
          platform: post.platform,
          format: post.format,
          postedAt: post.postedAt,
          submittedAt: post.submittedAt,
          publicUrl: post.publicUrl,
          caption: post.caption,
          creativeAngleTags: post.creativeAngleTags,
          hookText: post.hookText,
          metrics,
          derived: {
            engagementRate: er.value,
            engagementRateBasis: er.basis,
            totalEngagements: totalEngagements(metrics).value,
          },
          extraction: post.extraction
            ? {
                status: post.extraction.status,
                model: post.extraction.model,
                promptVersion: post.extraction.promptVersion,
                parseOk: post.extraction.parseOk,
                parseError: post.extraction.parseError,
                detectedPlatform: post.extraction.detectedPlatform,
                detectedScreenType: post.extraction.detectedScreenType,
                modelNotes: post.extraction.modelNotes,
                fieldConfidence: post.extraction.fieldConfidence,
                plausibility: post.extraction.plausibility,
                routingReasons: post.extraction.routingReasons,
                instructionTextDetected: post.extraction.instructionTextDetected ?? false,
                extractedAt: post.extraction.extractedAt,
                sourceImageSha256: post.extraction.sourceImageSha256,
              }
            : null,
          trust: post.trust ?? null,
          screenshotUrl: screenshot?.url ?? null,
          screenshotUrlExpiresAt: screenshot?.expiresAt ?? null,
          manualOverrides: post.manualOverrides,
          verifiedAt: post.verifiedAt,
          rejectedReason: post.rejectedReason,
        };
      }),
    );

    res.json({
      items,
      counts: Object.fromEntries(counts.map((c) => [c._id ?? 'unknown', c.n])),
      metricKeys: METRIC_KEYS,
    });
  }),
);

/* --------------------------------------------------------------- raw output */

/**
 * The exact model output for one post. Behind its own endpoint rather than in
 * the list payload: it is large, rarely needed, and looking at it is itself
 * worth an audit row.
 */
operatorQueueRouter.get(
  '/posts/:postId/raw',
  asyncRoute(async (req, res) => {
    const postId = readObjectIdParam(req.params.postId, 'post id');
    const post = await PostModel.findById(postId).lean();
    if (!post) throw ApiError.notFound('post_not_found', 'No such post.');

    res.json({
      rawResponse: post.extraction?.rawResponse ?? null,
      parseOk: post.extraction?.parseOk ?? null,
      parseError: post.extraction?.parseError ?? null,
      model: post.extraction?.model ?? null,
      promptVersion: post.extraction?.promptVersion ?? null,
      inputTokens: post.extraction?.inputTokens ?? null,
      outputTokens: post.extraction?.outputTokens ?? null,
    });
  }),
);

/* ------------------------------------------------------------- the decision */

const decisionSchema = z
  .object({
    decision: z.enum(['verify', 'reject']),
    metrics: postMetricsSchema,
    rejectedReason: z.string().max(500).nullable().default(null),
    /** Per-field justification for any value the operator changed. */
    overrideReasons: z.partialRecord(metricKeySchema, z.string().max(500)).default({}),
    creativeAngleTags: z.array(z.string().max(40)).max(8).default([]),
    hookText: z.string().max(300).nullable().default(null),
  })
  .refine((v) => v.decision !== 'reject' || (v.rejectedReason?.trim().length ?? 0) > 0, {
    message: 'a rejection must carry a reason',
    path: ['rejectedReason'],
  });

/**
 * Verify or reject one post.
 *
 * Every metric the operator changed writes an append-only override record
 * carrying from, to, who and when. There is no path through this route that
 * edits a number without leaving that trail — which is the entire reason a
 * brand can be shown these figures.
 */
operatorQueueRouter.post(
  '/posts/:postId/decide',
  asyncRoute(async (req, res) => {
    const postId = readObjectIdParam(req.params.postId, 'post id');
    const body = parseBody(decisionSchema, req);
    const { operator } = getOperator(req);

    const post = await PostModel.findById(postId);
    if (!post) throw ApiError.notFound('post_not_found', 'No such post.');
    if (post.extraction == null) {
      throw ApiError.badRequest('no_extraction', 'This post has no extraction to review.');
    }
    if (post.extraction.status === 'pending') {
      throw ApiError.conflict(
        'still_pending',
        'This post has not been through extraction yet. Run the extractor first.',
      );
    }

    const now = new Date();
    const before = post.metrics as PostMetrics;

    const overrides = METRIC_KEYS.flatMap((field: MetricKey) => {
      const from = before[field] ?? null;
      const to = body.metrics[field] ?? null;
      if (from === to) return [];
      return [
        {
          field,
          from,
          to,
          by: operator._id,
          at: now,
          reason: body.overrideReasons[field] ?? null,
        },
      ];
    });

    if (body.decision === 'reject') {
      await PostModel.updateOne(
        { _id: post._id },
        {
          $set: {
            'extraction.status': 'rejected',
            verifiedByOperatorId: operator._id,
            verifiedAt: now,
            rejectedReason: body.rejectedReason,
          },
          ...(overrides.length > 0 ? { $push: { manualOverrides: { $each: overrides } } } : {}),
        },
      );

      await recordAudit({
        actorKind: 'operator',
        actorId: operator._id,
        actorLabel: operator.email,
        action: AUDIT.postRejected,
        subjectKind: 'Post',
        subjectId: post._id,
        detail: { reason: body.rejectedReason, creatorId: post.creatorId.toString() },
        ipHash: hashIp(clientIp(req)),
      });

      res.json({ id: post._id.toString(), status: 'rejected', overridesRecorded: overrides.length });
      return;
    }

    await PostModel.updateOne(
      { _id: post._id },
      {
        $set: {
          metrics: body.metrics,
          'extraction.status': 'verified',
          verifiedByOperatorId: operator._id,
          verifiedAt: now,
          rejectedReason: null,
          creativeAngleTags: body.creativeAngleTags,
          hookText: body.hookText,
        },
        ...(overrides.length > 0 ? { $push: { manualOverrides: { $each: overrides } } } : {}),
      },
    );

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: overrides.length > 0 ? AUDIT.postOverridden : AUDIT.postVerified,
      subjectKind: 'Post',
      subjectId: post._id,
      detail: {
        creatorId: post.creatorId.toString(),
        overrides: overrides.map((o) => ({ field: o.field, from: o.from, to: o.to })),
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ id: post._id.toString(), status: 'verified', overridesRecorded: overrides.length });
  }),
);

/* ------------------------------------------------------------- spot audit */

const auditOutcomeSchema = z.object({
  outcome: z.enum(['passed', 'failed', 'creator_declined', 'not_contactable']),
  note: z.string().max(500).nullable().default(null),
});

/** Records the result of a live screen-share verification. */
operatorQueueRouter.post(
  '/posts/:postId/spot-audit',
  asyncRoute(async (req, res) => {
    const postId = readObjectIdParam(req.params.postId, 'post id');
    const body = parseBody(auditOutcomeSchema, req);
    const { operator } = getOperator(req);

    const post = await PostModel.findByIdAndUpdate(
      postId,
      { $set: { 'trust.spotAuditOutcome': body.outcome, 'trust.spotAuditAt': new Date() } },
      { new: true },
    );
    if (!post) throw ApiError.notFound('post_not_found', 'No such post.');

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: 'post.spot_audit.recorded',
      subjectKind: 'Post',
      subjectId: post._id,
      detail: { outcome: body.outcome, note: body.note, creatorId: post.creatorId.toString() },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ id: post._id.toString(), outcome: body.outcome });
  }),
);

/* --------------------------------------------------------------- dashboard */

/** Headline numbers for the operator landing screen, including spend. */
operatorQueueRouter.get(
  '/dashboard',
  asyncRoute(async (_req, res) => {
    const [statusCounts, injectionCount, auditsDue, spend] = await Promise.all([
      PostModel.aggregate<{ _id: string; n: number }>([
        { $group: { _id: '$extraction.status', n: { $sum: 1 } } },
      ]),
      PostModel.countDocuments({ 'extraction.instructionTextDetected': true }),
      PostModel.countDocuments({ 'trust.flaggedForSpotAudit': true, 'trust.spotAuditOutcome': null }),
      spendSummary(7),
    ]);

    res.json({
      posts: Object.fromEntries(statusCounts.map((c) => [c._id ?? 'unknown', c.n])),
      // Surfaced on the landing screen, not buried: an image trying to steer
      // the extractor is the thing you most want to know about today.
      instructionTextDetected: injectionCount,
      spotAuditsOutstanding: auditsDue,
      spend: {
        days: spend,
        todayMinor: spend[0]?.totalMinor ?? 0,
      },
    });
  }),
);
