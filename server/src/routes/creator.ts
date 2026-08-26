import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  EMPTY_METRICS,
  METRICS_BY_FORMAT,
  followerCountAsOf,
  httpUrlSchema,
  objectIdSchema,
  platformSchema,
  postFormatSchema,
  type Platform,
} from '@anton/shared';
import {
  CampaignCreatorModel,
  CampaignModel,
  ContentLicenseModel,
  CreatorModel,
  MagicLinkModel,
  PostModel,
  SessionModel,
} from '../db/models/index.js';
import {
  CREATOR_COOKIE,
  clearCreatorCookie,
  clientIp,
  exchangeMagicLink,
  getSession,
  requireConsent,
  requireCreator,
  revokeAllCreatorSessions,
  userAgentOf,
} from '../lib/creator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { consentIsCurrent, hashIp, loadConsentDocument } from '../config/consent.js';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { DAY_MS, HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { ingestImage } from '../lib/image-ingest.js';
import {
  MAX_UPLOAD_BYTES,
  READ_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  buildScreenshotKey,
  creatorIdFromKey,
  isAllowedUploadType,
} from '../storage/types.js';
import { getStorage } from '../storage/index.js';

export const creatorRouter: Router = Router();

/**
 * The creator surface. No password anywhere.
 *
 * A magic link is exchanged once for an httpOnly session cookie; after that
 * there is no credential in JavaScript at all. Every route is scoped to the
 * creator the session resolves to, and no route accepts a creator id from the
 * client.
 */

/* ----------------------------------------------------------- link exchange */

const exchangeSchema = z.object({ token: z.string().min(1).max(200) });

/**
 * The only unauthenticated creator route. Swaps a single-use magic-link token
 * for a session cookie, then the token is spent.
 */
creatorRouter.post(
  '/session/exchange',
  asyncRoute(async (req, res) => {
    const body = parseBody(exchangeSchema, req);
    const { creator } = await exchangeMagicLink(req, res, body.token);
    res.status(201).json({
      ok: true,
      creator: { id: creator._id.toString(), displayName: creator.displayName },
    });
  }),
);

/* -------------------------------------------------------------- GET session */

creatorRouter.get(
  '/session',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { creator, session } = getSession(req);
    const consentDoc = await loadConsentDocument();

    const joins = await CampaignCreatorModel.find({
      creatorId: creator._id,
      status: { $nin: ['declined'] },
    }).lean();

    const campaigns = await CampaignModel.find({
      _id: { $in: joins.map((j) => j.campaignId) },
      status: { $in: ['live', 'closed'] },
    }).lean();

    const posts = await PostModel.find({ creatorId: creator._id }).sort({ postedAt: -1 }).lean();

    const consentIsOnRecord = creator.consent != null && creator.consent.withdrawnAt == null;
    // A consent given against an older revision of CONSENT.md is stale: the
    // creator agreed to different words and must be asked again.
    const consentIsStale =
      consentIsOnRecord &&
      creator.consent != null &&
      !consentIsCurrent(
        { scopeVersion: creator.consent.scopeVersion, documentSha256: creator.consent.documentSha256 },
        consentDoc,
      );

    res.json({
      creator: {
        id: creator._id.toString(),
        displayName: creator.displayName,
        handles: creator.handles.map((h) => ({ platform: h.platform, handle: h.handle })),
      },
      consent: {
        required: !consentIsOnRecord || consentIsStale,
        reason: !consentIsOnRecord ? 'not_given' : consentIsStale ? 'document_changed' : null,
        version: consentDoc.version,
        text: consentDoc.text,
        grantedAt: creator.consent?.grantedAt ?? null,
      },
      campaigns: campaigns.map((campaign) => {
        const join = joins.find((j) => String(j.campaignId) === String(campaign._id));
        const mine = posts.filter((p) => String(p.campaignId) === String(campaign._id));
        return {
          id: campaign._id.toString(),
          name: campaign.name,
          brief: campaign.brief,
          platforms: campaign.platforms,
          startDate: campaign.startDate,
          endDate: campaign.endDate,
          status: join?.status ?? 'invited',
          deliverableSpec: campaign.deliverableSpec,
          outstanding: campaign.deliverableSpec.map((spec) => ({
            format: spec.format,
            required: spec.count,
            submitted: mine.filter((p) => p.format === spec.format).length,
          })),
        };
      }),
      submissions: posts.map((post) => ({
        id: post._id.toString(),
        campaignId: post.campaignId.toString(),
        platform: post.platform,
        format: post.format,
        postedAt: post.postedAt,
        publicUrl: post.publicUrl,
        state:
          post.extraction?.status === 'rejected'
            ? 'rejected'
            : post.extraction?.status === 'pending'
              ? 'processing'
              : 'received',
      })),
      session: { expiresAt: session.expiresAt, startedAt: session.issuedAt },
    });
  }),
);

/* ---------------------------------------------------------------- sessions */

/** Every device currently signed in as this creator. */
creatorRouter.get(
  '/sessions',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { creator, session } = getSession(req);
    const sessions = await SessionModel.find({
      creatorId: creator._id,
      subjectKind: 'creator',
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    })
      .sort({ issuedAt: -1 })
      .lean();

    res.json({
      sessions: sessions.map((s) => ({
        id: s._id.toString(),
        startedAt: s.issuedAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        // A coarse description, not the full UA string: enough for a creator to
        // recognise their own device without publishing a fingerprint.
        device: describeUserAgent(s.userAgent),
        isThisDevice: String(s._id) === String(session._id),
      })),
    });
  }),
);

function describeUserAgent(ua: string): string {
  if (!ua) return 'Unknown device';
  const os = /iPhone|iPad/i.test(ua)
    ? 'iPhone or iPad'
    : /Android/i.test(ua)
      ? 'Android'
      : /Mac OS X/i.test(ua)
        ? 'Mac'
        : /Windows/i.test(ua)
          ? 'Windows'
          : 'Unknown device';
  const browser = /CriOS|Chrome/i.test(ua)
    ? 'Chrome'
    : /FxiOS|Firefox/i.test(ua)
      ? 'Firefox'
      : /Safari/i.test(ua)
        ? 'Safari'
        : 'browser';
  return `${os} · ${browser}`;
}

/** Signs out everywhere. The creator's own kill switch for a shared link. */
creatorRouter.post(
  '/sessions/revoke-all',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const count = await revokeAllCreatorSessions(creator._id, 'creator requested sign-out everywhere');
    // Every link the creator holds is also killed: if they are revoking because
    // a link leaked, leaving unspent links alive would defeat the point.
    await MagicLinkModel.updateMany(
      { creatorId: creator._id, revokedAt: null, usedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    clearCreatorCookie(res);

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.creatorSessionsRevoked,
      subjectKind: 'Creator',
      subjectId: creator._id,
      detail: { sessionsRevoked: count },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({
      sessionsRevoked: count,
      message: 'Signed out everywhere and all your unused links cancelled. Ask in the community for a fresh one.',
    });
  }),
);

creatorRouter.post(
  '/session/end',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { session } = getSession(req);
    await SessionModel.updateOne(
      { _id: session._id },
      { $set: { revokedAt: new Date(), revokedReason: 'signed out' } },
    );
    clearCreatorCookie(res);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------ POST consent */

const consentBodySchema = z.object({
  agreed: z.literal(true, { message: 'consent must be affirmative' }),
  scopeVersion: z.string().min(1).max(32),
  method: z.enum(['whatsapp_message', 'web_form']).default('web_form'),
});

creatorRouter.post(
  '/consent',
  requireCreator,
  asyncRoute(async (req, res) => {
    const body = parseBody(consentBodySchema, req);
    const { creator } = getSession(req);
    const consentDoc = await loadConsentDocument();

    if (body.scopeVersion !== consentDoc.version) {
      throw ApiError.conflict(
        'consent_version_mismatch',
        'The agreement was updated while this page was open. Please reload and read it again.',
      );
    }

    const now = new Date();
    const ipHash = hashIp(clientIp(req));
    await CreatorModel.updateOne(
      { _id: creator._id },
      {
        $set: {
          consent: {
            grantedAt: now,
            scopeVersion: consentDoc.version,
            documentSha256: consentDoc.sha256,
            ipHash,
            method: body.method,
            withdrawnAt: null,
          },
          ...(creator.status === 'invited' ? { status: 'active' } : {}),
          ...(creator.joinedAt ? {} : { joinedAt: now }),
        },
      },
    );

    await MagicLinkModel.updateOne(
      { creatorId: creator._id, consentCapturedAt: null },
      { $set: { consentCapturedAt: now } },
    );

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.creatorConsentGiven,
      subjectKind: 'Creator',
      subjectId: creator._id,
      detail: { scopeVersion: consentDoc.version, documentSha256: consentDoc.sha256 },
      ipHash,
    });

    res.status(201).json({ grantedAt: now, scopeVersion: consentDoc.version });
  }),
);

/* ------------------------------------------------------ POST upload presign */

const presignBodySchema = z.object({
  campaignId: objectIdSchema,
  contentType: z.string().min(1).max(80),
  byteLength: z.number().int().positive().max(MAX_UPLOAD_BYTES * 2),
});

/**
 * Issues a presigned PUT. The key is built server-side from the session's own
 * creator id and a fresh UUID: the client cannot choose, guess, or influence it.
 */
creatorRouter.post(
  '/uploads/presign',
  requireCreator,
  requireConsent,
  asyncRoute(async (req, res) => {
    const body = parseBody(presignBodySchema, req);
    const { creator } = getSession(req);
    const env = loadEnv();

    await enforceRateLimit(
      {
        bucket: 'upload_creator',
        subject: creator._id.toString(),
        limit: env.RATE_LIMIT_UPLOADS_PER_CREATOR_HOUR,
        windowMs: HOUR_MS,
      },
      'You have sent a lot of screenshots in the last hour. Try again shortly.',
    );
    await enforceRateLimit(
      {
        bucket: 'upload_global',
        subject: 'global',
        limit: env.RATE_LIMIT_UPLOADS_GLOBAL_DAY,
        windowMs: DAY_MS,
      },
      'Anton is at its daily upload limit. Try again tomorrow.',
    );

    if (!isAllowedUploadType(body.contentType)) {
      throw ApiError.badRequest('unsupported_type', 'Upload a JPEG, PNG or WebP screenshot.');
    }
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      throw ApiError.tooLarge(
        'file_too_large',
        `That image is larger than ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB even after resizing.`,
      );
    }

    const join = await CampaignCreatorModel.findOne({
      campaignId: new Types.ObjectId(body.campaignId),
      creatorId: creator._id,
    });
    if (!join) throw ApiError.forbidden('not_on_campaign', 'You are not on this campaign.');

    const key = buildScreenshotKey(creator._id.toString(), randomUUID());
    const presigned = await getStorage().presignUpload({
      key,
      contentType: body.contentType,
      maxBytes: MAX_UPLOAD_BYTES,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });

    res.status(201).json(presigned);
  }),
);

/* ---------------------------------------------------------------- POST post */

const submitBodySchema = z.object({
  campaignId: objectIdSchema,
  platform: platformSchema,
  format: postFormatSchema,
  publicUrl: httpUrlSchema.nullable().default(null),
  postedAt: z.coerce.date(),
  sourceImageKey: z.string().min(1).max(512),
  caption: z.string().max(2200).nullable().default(null),
});

creatorRouter.post(
  '/posts',
  requireCreator,
  requireConsent,
  asyncRoute(async (req, res) => {
    const body = parseBody(submitBodySchema, req);
    const { creator } = getSession(req);
    const env = loadEnv();

    const join = await CampaignCreatorModel.findOne({
      campaignId: new Types.ObjectId(body.campaignId),
      creatorId: creator._id,
    });
    if (!join) throw ApiError.forbidden('not_on_campaign', 'You are not on this campaign.');

    const campaign = await CampaignModel.findById(body.campaignId);
    if (!campaign) throw ApiError.notFound('campaign_not_found', 'That campaign no longer exists.');

    // The key must be one we could have issued, to THIS creator. Parsed from
    // the key's own structure rather than string-prefix trusted.
    if (creatorIdFromKey(body.sourceImageKey) !== creator._id.toString()) {
      throw ApiError.forbidden('key_not_yours', 'That upload does not belong to this submission.');
    }

    const storage = getStorage();
    if (!(await storage.objectExists(body.sourceImageKey))) {
      throw ApiError.badRequest('upload_missing', 'The screenshot did not finish uploading. Try again.');
    }

    // Server-side validation of what actually landed: magic bytes, real decode,
    // EXIF recorded then stripped. The normalised bytes replace the original in
    // storage, so nothing unparsed by the decoder is ever retained.
    const uploaded = await storage.readObject(body.sourceImageKey);
    const declaredType = uploaded.length > 3 && uploaded[0] === 0xff ? 'image/jpeg' : detectDeclared(uploaded);
    const ingested = await ingestImage(uploaded, declaredType, MAX_UPLOAD_BYTES);
    await storage.writeObject(body.sourceImageKey, ingested.bytes, ingested.contentType);

    const sourceImageSha256 = createHash('sha256').update(ingested.bytes).digest('hex');

    const duplicate = await PostModel.findOne({
      creatorId: creator._id,
      campaignId: campaign._id,
      'extraction.sourceImageSha256': sourceImageSha256,
    });
    if (duplicate) {
      throw ApiError.conflict('already_submitted', 'You have already submitted this screenshot.');
    }

    const now = new Date();
    const submissionLagHours = (now.getTime() - body.postedAt.getTime()) / HOUR_MS;
    // Random, but only at submission time and recorded immediately, so an
    // operator cannot re-roll a post out of being audited.
    const flaggedForAudit = Math.random() < env.SPOT_AUDIT_RATE;

    const post = await PostModel.create({
      creatorId: creator._id,
      campaignId: campaign._id,
      platform: body.platform,
      format: body.format,
      publicUrl: body.publicUrl,
      postedAt: body.postedAt,
      caption: body.caption,
      creativeAngleTags: [],
      hookText: null,
      metrics: EMPTY_METRICS,
      metricSource: 'screenshot',
      extraction: {
        sourceImageKey: body.sourceImageKey,
        sourceImageSha256,
        extractedAt: now,
        model: '',
        promptVersion: '',
        rawResponse: '',
        parseOk: false,
        parseError: null,
        detectedPlatform: null,
        detectedScreenType: null,
        modelNotes: null,
        fieldConfidence: {},
        plausibility: { passed: false, violations: [], skipped: [] },
        status: 'pending',
        routingReasons: [],
        inputTokens: null,
        outputTokens: null,
      },
      trust: {
        submissionLagHours: Math.max(0, Math.round(submissionLagHours * 10) / 10),
        withinSubmissionWindow: submissionLagHours <= env.SUBMISSION_WINDOW_HOURS,
        exifPresent: ingested.exifPresent,
        exifCaptureTimestamp: ingested.captureTimestamp,
        flaggedForSpotAudit: flaggedForAudit,
        spotAuditOutcome: null,
        spotAuditAt: null,
        publicCrossCheck: null,
        historicalDeviation: null,
      },
      verifiedByOperatorId: null,
      verifiedAt: null,
      rejectedReason: null,
      manualOverrides: [],
      submittedAt: now,
    });

    await CampaignCreatorModel.updateOne(
      { _id: join._id },
      {
        $set: {
          lastSubmissionAt: now,
          ...(join.firstPostedAt ? {} : { firstPostedAt: body.postedAt }),
          ...(['accepted', 'shipped', 'posted'].includes(join.status) ? { status: 'reported' } : {}),
        },
        $push: {
          history: { from: join.status, to: 'reported', at: now, by: 'creator', note: 'Insights submitted.' },
        },
      },
    );

    await MagicLinkModel.updateOne(
      { creatorId: creator._id, firstSubmissionAt: null },
      { $set: { firstSubmissionAt: now } },
    );

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.postSubmitted,
      subjectKind: 'Post',
      subjectId: post._id,
      detail: {
        campaignId: campaign._id.toString(),
        format: body.format,
        submissionLagHours: Math.round(submissionLagHours),
        exifPresent: ingested.exifPresent,
        flaggedForSpotAudit: flaggedForAudit,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json({
      id: post._id.toString(),
      state: 'processing',
      message: 'Got it. We will read the numbers off your screenshot and check them.',
    });
  }),
);

/** Best-effort declared type from bytes, for the ingest mismatch check. */
function detectDeclared(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF') return 'image/webp';
  return 'image/jpeg';
}

/* -------------------------------------------------------------- reference */

creatorRouter.get(
  '/formats',
  requireCreator,
  asyncRoute(async (_req, res) => {
    res.json({ metricsByFormat: METRICS_BY_FORMAT });
  }),
);

/* ------------------------------------------------------------ data rights */

creatorRouter.get(
  '/export',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const storage = getStorage();

    const [joins, posts, links, licences] = await Promise.all([
      CampaignCreatorModel.find({ creatorId: creator._id }).lean(),
      PostModel.find({ creatorId: creator._id }).lean(),
      MagicLinkModel.find({ creatorId: creator._id }).lean(),
      ContentLicenseModel.find({ creatorId: creator._id }).lean(),
    ]);

    const campaigns = await CampaignModel.find({ _id: { $in: joins.map((j) => j.campaignId) } })
      .select('name brief startDate endDate')
      .lean();

    const screenshots = await Promise.all(
      posts
        .filter((p) => p.extraction?.sourceImageKey)
        .map(async (p) => {
          const key = p.extraction?.sourceImageKey ?? '';
          const read = await storage.presignRead(key, READ_URL_TTL_SECONDS);
          return {
            postId: p._id.toString(),
            sha256: p.extraction?.sourceImageSha256 ?? null,
            downloadUrl: read.url,
            urlExpiresAt: read.expiresAt,
          };
        }),
    );

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.creatorExported,
      subjectKind: 'Creator',
      subjectId: creator._id,
      detail: { posts: posts.length },
      ipHash: hashIp(clientIp(req)),
    });

    res.setHeader('content-disposition', `attachment; filename="anton-export-${creator._id.toString()}.json"`);
    res.json({
      exportedAt: new Date(),
      note: 'Download links expire 60 seconds after this file was generated. Re-export for fresh ones.',
      profile: {
        displayName: creator.displayName,
        email: creator.email,
        handles: creator.handles,
        followerSnapshots: creator.followerSnapshots,
        nicheTags: creator.nicheTags,
        country: creator.country,
        city: creator.city,
        languages: creator.languages,
        joinedAt: creator.joinedAt,
        status: creator.status,
      },
      consent: creator.consent,
      contentLicences: licences,
      campaigns,
      participation: joins,
      posts,
      accessLinks: links.map((l) => ({
        issuedAt: l.issuedAt,
        expiresAt: l.expiresAt,
        usedAt: l.usedAt,
        openCount: l.openCount,
        firstOpenedAt: l.firstOpenedAt,
        consentCapturedAt: l.consentCapturedAt,
      })),
      screenshots,
    });
  }),
);

const deleteBodySchema = z.object({
  confirm: z.literal('DELETE', { message: 'type DELETE to confirm' }),
});

/**
 * Genuine deletion, not a soft-delete flag: objects leave storage, rows leave
 * the database. What survives is the consent tombstone, and CONSENT.md says so
 * plainly rather than burying it.
 */
creatorRouter.post(
  '/delete',
  requireCreator,
  asyncRoute(async (req, res) => {
    parseBody(deleteBodySchema, req);
    const { creator } = getSession(req);
    const storage = getStorage();

    const posts = await PostModel.find({ creatorId: creator._id }).lean();
    const imageKeys = posts
      .map((p) => p.extraction?.sourceImageKey)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);

    const deletions = await Promise.allSettled(imageKeys.map((k) => storage.deleteObject(k)));
    const failedKeys = imageKeys.filter((_, i) => deletions[i]?.status === 'rejected');

    await PostModel.deleteMany({ creatorId: creator._id });
    await CampaignCreatorModel.deleteMany({ creatorId: creator._id });
    await ContentLicenseModel.deleteMany({ creatorId: creator._id });
    await MagicLinkModel.updateMany(
      { creatorId: creator._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    await revokeAllCreatorSessions(creator._id, 'account deleted');

    const now = new Date();
    await CreatorModel.updateOne(
      { _id: creator._id },
      {
        $set: {
          status: 'removed',
          displayName: 'Deleted creator',
          email: null,
          handles: [],
          followerSnapshots: [],
          nicheTags: [],
          country: null,
          city: null,
          languages: [],
          whatsappCommunityId: null,
          notes: null,
          payoutDetails: { method: null, accountRefToken: null, taxCountry: null, verifiedAt: null },
          ...(creator.consent ? { 'consent.withdrawnAt': now } : {}),
        },
      },
    );

    clearCreatorCookie(res);

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: 'Deleted creator',
      action: AUDIT.creatorDeleted,
      subjectKind: 'Creator',
      subjectId: creator._id,
      detail: {
        postsRemoved: posts.length,
        screenshotsRemoved: imageKeys.length - failedKeys.length,
        // Named explicitly so a failed storage delete is actionable rather
        // than a number nobody can act on.
        screenshotsFailedKeys: failedKeys,
      },
      ipHash: hashIp(clientIp(req)),
    });

    if (failedKeys.length > 0) {
      console.error(
        `[creator] deletion for ${creator._id.toString()}: ${failedKeys.length} screenshots survived and need manual removal:`,
        failedKeys,
      );
    }

    res.json({
      deletedAt: now,
      postsRemoved: posts.length,
      screenshotsRemoved: imageKeys.length - failedKeys.length,
      screenshotsFailed: failedKeys.length,
      consentRecordRetained: creator.consent != null,
      message:
        failedKeys.length === 0
          ? 'Everything has been deleted. Your links no longer work.'
          : 'Your data has been deleted. Some images could not be removed automatically and have been flagged for manual removal.',
    });
  }),
);

creatorRouter.post(
  '/consent/withdraw',
  requireCreator,
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    if (!creator.consent) {
      throw ApiError.badRequest('no_consent', 'There is no consent on record to withdraw.');
    }
    const now = new Date();
    await CreatorModel.updateOne(
      { _id: creator._id },
      { $set: { 'consent.withdrawnAt': now, status: 'paused' } },
    );
    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.creatorConsentWithdrawn,
      subjectKind: 'Creator',
      subjectId: creator._id,
      ipHash: hashIp(clientIp(req)),
    });
    res.json({
      withdrawnAt: now,
      message:
        'Consent withdrawn. We will not use your data for anything new. Existing campaign reports stand; use Delete if you want those removed too.',
    });
  }),
);

/* -------------------------------------------------------- follower history */

const followerBodySchema = z.object({
  platform: platformSchema,
  count: z.number().int().nonnegative().max(10_000_000_000),
});

creatorRouter.post(
  '/followers',
  requireCreator,
  requireConsent,
  asyncRoute(async (req, res) => {
    const body = parseBody(followerBodySchema, req);
    const { creator } = getSession(req);

    if (!creator.handles.some((h) => h.platform === body.platform)) {
      throw ApiError.badRequest('no_handle', `You have no ${body.platform} handle on record.`);
    }

    const now = new Date();
    await CreatorModel.updateOne(
      { _id: creator._id },
      {
        $push: {
          followerSnapshots: { platform: body.platform, count: body.count, capturedAt: now, source: 'manual' },
        },
      },
    );

    const updated = await CreatorModel.findById(creator._id).lean();
    const latest = followerCountAsOf(
      (updated?.followerSnapshots ?? []).map((s) => ({
        platform: s.platform as Platform,
        count: s.count,
        capturedAt: s.capturedAt,
        source: s.source as 'manual' | 'screenshot' | 'oauth',
      })),
      body.platform,
      now,
    );

    res.status(201).json({ capturedAt: now, count: latest?.count ?? body.count });
  }),
);

export { CREATOR_COOKIE, userAgentOf };
