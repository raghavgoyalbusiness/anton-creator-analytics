import { Router } from 'express';
import { z } from 'zod';
import {
  AD_PLATFORMS,
  AD_PLATFORM_LABELS,
  USE_EXPLANATIONS,
  USE_LABELS,
  WORLDWIDE,
  licenceStatus,
  normaliseAdCode,
  type AdPlatform,
  type PermittedUse,
} from '@anton/shared';
import { ContentLicenseModel, toLicenceLike } from '../db/models/ContentLicense.js';
import { BrandModel, CampaignModel, PostModel } from '../db/models/index.js';
import { clientIp, getSession, requireConsent, requireCreator } from '../lib/creator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { hashTerms } from './licensing.js';

export const creatorLicensingRouter: Router = Router();
creatorLicensingRouter.use(requireCreator);

/**
 * Licensing, from the creator's side.
 *
 * This is the only place in the codebase that writes `grantedAt`. An operator
 * can propose terms; only the person whose face and work it is can agree to
 * them, and only here, on their own authenticated session.
 *
 * The terms are shown in full and in plain words before the button, and the
 * exact wording is hashed into the record. If the terms change afterwards, the
 * grant is recognisably against the old ones rather than silently reused for
 * something the creator never read.
 */

/**
 * Turns stored terms into sentences.
 *
 * Written here rather than in the front end so the record and the words the
 * creator saw cannot drift apart — and so a creator asking "what did I agree
 * to?" in six months gets the same sentences from the API, not a rendering of
 * whatever the UI says today.
 */
function describeTerms(licence: {
  permittedUses: readonly string[];
  territory: readonly string[];
  startsAt: Date;
  endsAt?: Date | null;
  nameAndLikenessPermitted: boolean;
  modificationPermitted: boolean;
  whitelistingPermitted: boolean;
  scope: string;
  postIds: readonly unknown[];
}): { headline: string; points: string[] } {
  const points: string[] = [];

  for (const use of licence.permittedUses) {
    const label = USE_LABELS[use as PermittedUse];
    const why = USE_EXPLANATIONS[use as PermittedUse];
    points.push(label ? `${label}. ${why ?? ''}`.trim() : use);
  }

  points.push(
    licence.territory.includes(WORLDWIDE)
      ? 'Anywhere in the world.'
      : `Only in: ${licence.territory.join(', ')}.`,
  );

  /**
   * A perpetual licence is the single most consequential term on the page, so
   * it is stated in those words rather than as an absent end date.
   */
  points.push(
    licence.endsAt == null
      ? 'With no end date. This does not expire — the brand could still be using it years from now, unless you withdraw it.'
      : `From ${licence.startsAt.toISOString().slice(0, 10)} until ${licence.endsAt
          .toISOString()
          .slice(0, 10)}. After that they must stop.`,
  );

  if (licence.modificationPermitted) {
    points.push('They can cut, edit, or re-caption your video.');
  } else {
    points.push('They cannot edit or recut your video.');
  }

  if (licence.nameAndLikenessPermitted) {
    points.push('They can use your name and your face in their own marketing.');
  }

  if (licence.whitelistingPermitted) {
    points.push(
      'They can run ads from your handle, so the ad looks like it came from you. You can withdraw this at any time.',
    );
  }

  const headline =
    licence.scope === 'all_campaign_posts'
      ? 'Every post you make on this campaign'
      : `${licence.postIds.length} specific ${licence.postIds.length === 1 ? 'post' : 'posts'}`;

  return { headline, points };
}

/* ------------------------------------------------------------------ list */

creatorLicensingRouter.get(
  '/licences',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const now = new Date();

    const licences = await ContentLicenseModel.find({ creatorId: creator._id }).lean();
    const campaigns = await CampaignModel.find({ _id: { $in: licences.map((l) => l.campaignId) } })
      .select('name brandId')
      .lean();
    const brands = await BrandModel.find({ _id: { $in: campaigns.map((c) => c.brandId) } })
      .select('name')
      .lean();

    const campaignById = new Map(campaigns.map((c) => [c._id.toString(), c]));
    const brandById = new Map(brands.map((b) => [b._id.toString(), b.name]));

    res.json({
      licences: licences.map((l) => {
        const campaign = campaignById.get(l.campaignId.toString());
        const status = licenceStatus(toLicenceLike(l), now);
        const terms = describeTerms(l);
        return {
          id: l._id.toString(),
          campaignId: l.campaignId.toString(),
          campaignName: campaign?.name ?? 'Campaign',
          brandName: campaign ? (brandById.get(campaign.brandId.toString()) ?? null) : null,
          state: status.state,
          summary: status.summary,
          /** The decision is only pending while it is actually pending. */
          needsYourDecision: status.state === 'awaiting_creator',
          headline: terms.headline,
          points: terms.points,
          isPerpetual: status.isPerpetual,
          licenseFeeMinor: l.licenseFeeMinor ?? null,
          currency: l.currency ?? null,
          grantedAt: l.grantedAt ?? null,
          revokedAt: l.revokedAt ?? null,
          startsAt: l.startsAt,
          endsAt: l.endsAt ?? null,
          termsSha256: l.termsSha256 ?? null,
        };
      }),
    });
  }),
);

/* ----------------------------------------------------------------- grant */

const grantSchema = z.object({
  /**
   * The hash of the terms the creator was actually shown.
   *
   * Sent back so a grant cannot land against terms that changed between the
   * page loading and the button being pressed. Same guard as the consent
   * document version.
   */
  termsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  agree: z.literal(true),
});

creatorLicensingRouter.post(
  '/licences/:licenceId/grant',
  requireConsent,
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const licenceIdRaw = req.params.licenceId;
    if (typeof licenceIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(licenceIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid licence id.');
    }
    const body = parseBody(grantSchema, req);

    const licence = await ContentLicenseModel.findOne({
      _id: licenceIdRaw,
      creatorId: creator._id,
    });
    if (!licence) throw ApiError.notFound('licence_not_found', 'No such request for you.');

    if (licence.grantedAt) {
      throw ApiError.conflict('already_granted', 'You have already agreed to this.');
    }
    if (licence.revokedAt) {
      throw ApiError.gone('withdrawn', 'This request was withdrawn.');
    }

    /**
     * The hash is recomputed from what is stored rather than trusting the one
     * on the row: a stored hash and stored terms that disagree would let a
     * changed licence pass the check.
     */
    const current = hashTerms(licence);
    if (current !== body.termsSha256) {
      throw ApiError.conflict(
        'terms_changed',
        'These terms have changed since you opened this page. Please read them again.',
      );
    }

    licence.grantedAt = new Date();
    licence.grantMethod = 'web_form';
    licence.grantDocumentSha256 = current;
    licence.grantIpHash = hashIp(clientIp(req));
    await licence.save();

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.licenceGranted,
      subjectKind: 'ContentLicense',
      subjectId: licence._id,
      detail: {
        campaignId: licence.campaignId.toString(),
        permittedUses: licence.permittedUses,
        perpetual: licence.endsAt == null,
        termsSha256: current,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true, grantedAt: licence.grantedAt });
  }),
);

/* -------------------------------------------------------------- withdraw */

const withdrawSchema = z.object({ reason: z.string().max(400).nullable().default(null) });

/**
 * A creator can withdraw at any time, and does not have to say why.
 *
 * Requiring a reason to stop someone using your face would be a dark pattern.
 * The field exists because some people want to explain; it is optional because
 * nobody should have to.
 */
creatorLicensingRouter.post(
  '/licences/:licenceId/withdraw',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const licenceIdRaw = req.params.licenceId;
    if (typeof licenceIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(licenceIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid licence id.');
    }
    const body = parseBody(withdrawSchema, req);

    const doc = await ContentLicenseModel.findOneAndUpdate(
      { _id: licenceIdRaw, creatorId: creator._id, revokedAt: null },
      {
        $set: {
          revokedAt: new Date(),
          revokedReason: body.reason ?? 'withdrawn by the creator',
        },
      },
      { new: true },
    );
    if (!doc) throw ApiError.notFound('licence_not_found', 'No such licence still in force.');

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.licenceWithdrawn,
      subjectKind: 'ContentLicense',
      subjectId: doc._id,
      detail: { campaignId: doc.campaignId.toString(), reason: body.reason },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true, revokedAt: doc.revokedAt });
  }),
);

/* -------------------------------------------------------- ad authorisation */

const adCodeSchema = z.object({
  platform: z.enum(AD_PLATFORMS),
  code: z.string().min(1).max(200),
  /** The creator reads this off the platform when they generate the code. */
  expiresAt: z.coerce.date().nullable().default(null),
});

/**
 * The creator supplies a platform ad authorisation code.
 *
 * Only they can. A TikTok Spark code or a Meta partnership code is generated
 * inside the creator's own account, and Anton neither has nor wants the access
 * that would let it create one on their behalf.
 *
 * Behind requireConsent, and separately gated on the licence: a code without a
 * licence permitting paid amplification would let a brand run an ad the creator
 * never agreed to, which is the exact failure this whole step exists to stop.
 */
creatorLicensingRouter.post(
  '/posts/:postId/ad-authorisation',
  requireConsent,
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const postIdRaw = req.params.postId;
    if (typeof postIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(postIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid post id.');
    }
    const body = parseBody(adCodeSchema, req);

    await enforceRateLimit(
      { bucket: 'ad_code', subject: creator._id.toString(), limit: 30, windowMs: HOUR_MS },
      'Too many attempts. Try again shortly.',
    );

    const normalised = normaliseAdCode(body.code);
    if (!normalised.ok) {
      throw ApiError.badRequest('bad_ad_code', `That does not look right — ${normalised.reason}.`);
    }

    if (body.expiresAt !== null && body.expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest(
        'already_expired',
        'That code has already expired. Generate a fresh one on the app and send us that.',
      );
    }

    const post = await PostModel.findOne({ _id: postIdRaw, creatorId: creator._id });
    if (!post) throw ApiError.notFound('post_not_found', 'That is not one of your posts.');

    const licence = await ContentLicenseModel.findOne({
      campaignId: post.campaignId,
      creatorId: creator._id,
    }).lean();

    if (!licence?.grantedAt || licence.revokedAt || !licence.permittedUses.includes('paid_amplification')) {
      throw ApiError.forbidden(
        'ads_not_licensed',
        'You have not agreed to let this brand run ads with your post, so there is nothing for this code to do. Agree to that first if you want to.',
      );
    }

    const now = new Date();

    /**
     * Superseding, not replacing: a previous code is marked withdrawn and kept.
     * "They gave us a code and then it changed" is a fact somebody will need to
     * establish when an ad stops running.
     */
    for (const existing of post.adAuthorisations) {
      if (existing.platform === body.platform && existing.revokedAt == null) {
        existing.revokedAt = now;
        existing.revokedReason = 'replaced by a newer code';
      }
    }

    post.adAuthorisations.push({
      platform: body.platform,
      code: normalised.code,
      providedAt: now,
      expiresAt: body.expiresAt,
      revokedAt: null,
      revokedReason: null,
    });
    await post.save();

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.adAuthorisationProvided,
      subjectKind: 'Post',
      subjectId: post._id,
      // The code itself is not logged. It is a credential for running ads.
      detail: {
        platform: body.platform,
        expiresAt: body.expiresAt?.toISOString() ?? null,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json({
      ok: true,
      platform: body.platform,
      platformLabel: AD_PLATFORM_LABELS[body.platform as AdPlatform],
      expiresAt: body.expiresAt,
    });
  }),
);

/** The creator withdraws an ad code without withdrawing the whole licence. */
creatorLicensingRouter.post(
  '/posts/:postId/ad-authorisation/withdraw',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const postIdRaw = req.params.postId;
    if (typeof postIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(postIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid post id.');
    }

    const post = await PostModel.findOne({ _id: postIdRaw, creatorId: creator._id });
    if (!post) throw ApiError.notFound('post_not_found', 'That is not one of your posts.');

    let withdrew = 0;
    for (const auth of post.adAuthorisations) {
      if (auth.revokedAt == null) {
        auth.revokedAt = new Date();
        auth.revokedReason = 'withdrawn by the creator';
        withdrew += 1;
      }
    }
    if (withdrew === 0) {
      throw ApiError.notFound('no_authorisation', 'There is no live ad code on that post.');
    }
    await post.save();

    await recordAudit({
      actorKind: 'creator',
      actorId: creator._id,
      actorLabel: creator.displayName,
      action: AUDIT.adAuthorisationWithdrawn,
      subjectKind: 'Post',
      subjectId: post._id,
      detail: { withdrew },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true, withdrew });
  }),
);

/**
 * Which of the creator's posts carry a live ad code, and on what.
 *
 * The code is never returned to the creator either — they generated it and can
 * see it on the platform, and a credential should not sit in a response that
 * gets screenshotted.
 */
creatorLicensingRouter.get(
  '/ad-authorisations',
  asyncRoute(async (req, res) => {
    const { creator } = getSession(req);
    const posts = await PostModel.find({ creatorId: creator._id })
      .select('_id campaignId platform format postedAt adAuthorisations')
      .lean();

    const now = Date.now();
    res.json({
      posts: posts
        .filter((p) => p.adAuthorisations.length > 0)
        .map((p) => {
          const live = p.adAuthorisations.find((a) => a.revokedAt == null) ?? null;
          return {
            postId: p._id.toString(),
            campaignId: p.campaignId.toString(),
            platform: p.platform,
            format: p.format,
            postedAt: p.postedAt,
            adPlatform: live?.platform ?? null,
            adPlatformLabel: live ? AD_PLATFORM_LABELS[live.platform as AdPlatform] : null,
            providedAt: live?.providedAt ?? null,
            expiresAt: live?.expiresAt ?? null,
            expired: live?.expiresAt != null && live.expiresAt.getTime() < now,
            live: live !== null,
          };
        }),
    });
  }),
);
