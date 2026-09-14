import { createHash } from 'node:crypto';
import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  AD_PLATFORMS,
  PERMITTED_USES,
  USE_LABELS,
  WORLDWIDE,
  adReadiness,
  licenceStatus,
  needsAttentionSoon,
  objectIdSchema,
  type PermittedUse,
} from '@anton/shared';
import { ContentLicenseModel, toLicenceLike } from '../db/models/ContentLicense.js';
import {
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  PostModel,
} from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';

export const licensingRouter: Router = Router();
licensingRouter.use(requireOperator);

/**
 * Content licensing, from the operator's side.
 *
 * The operator can PROPOSE terms. Only the creator can grant them, on their own
 * magic link, and that route lives in creator-licensing.ts. Nothing here writes
 * `grantedAt`, and that is deliberate: a system where an operator can record a
 * creator's agreement on their behalf has no agreement in it, only a claim.
 */

const territorySchema = z
  .array(z.string().regex(/^([A-Z]{2}|WORLDWIDE)$/, 'a two-letter country code, or WORLDWIDE'))
  .min(1, 'a licence has to say where it applies');

const requestSchema = z.object({
  campaignCreatorId: objectIdSchema,
  scope: z.enum(['all_campaign_posts', 'named_posts']),
  postIds: z.array(objectIdSchema).default([]),
  permittedUses: z
    .array(z.enum(PERMITTED_USES))
    .min(1, 'a licence request has to ask for at least one use'),
  territory: territorySchema,
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().default(null),
  nameAndLikenessPermitted: z.boolean().default(false),
  modificationPermitted: z.boolean().default(false),
  whitelistingPermitted: z.boolean().default(false),
  licenseFeeMinor: z.number().int().nonnegative().nullable().default(null),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  notes: z.string().max(2000).nullable().default(null),
});

/**
 * The wording the creator will be shown, hashed.
 *
 * Same reasoning as the consent document hash: if the terms later change, a
 * grant recorded against the old wording must be recognisable as stale rather
 * than silently reused for something the creator never read.
 */
export function hashTerms(terms: {
  permittedUses: readonly string[];
  territory: readonly string[];
  startsAt: Date;
  // Mongoose hands back `Date | null | undefined` for an optional path, and a
  // stored document has to hash identically to the request that created it.
  endsAt?: Date | null;
  nameAndLikenessPermitted: boolean;
  modificationPermitted: boolean;
  whitelistingPermitted: boolean;
}): string {
  const canonical = JSON.stringify({
    uses: [...terms.permittedUses].sort(),
    territory: [...terms.territory].sort(),
    from: terms.startsAt.toISOString(),
    to: terms.endsAt?.toISOString() ?? null,
    likeness: terms.nameAndLikenessPermitted,
    modification: terms.modificationPermitted,
    whitelisting: terms.whitelistingPermitted,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function joinForOperator(
  campaignCreatorId: string,
): Promise<{ creatorId: Types.ObjectId; campaignId: Types.ObjectId; brandId: Types.ObjectId }> {
  const join = await CampaignCreatorModel.findById(campaignCreatorId).lean();
  if (!join) throw ApiError.notFound('join_not_found', 'No such campaign participation.');
  const campaign = await CampaignModel.findById(join.campaignId).select('brandId').lean();
  if (!campaign) throw ApiError.notFound('campaign_not_found', 'No such campaign.');
  return { creatorId: join.creatorId, campaignId: join.campaignId, brandId: campaign.brandId };
}

/* -------------------------------------------------------------- request */

licensingRouter.post(
  '/licences/request',
  asyncRoute(async (req, res) => {
    const body = parseBody(requestSchema, req);
    const { operator } = getOperator(req);
    const { creatorId, campaignId, brandId } = await joinForOperator(body.campaignCreatorId);

    if (body.scope === 'named_posts' && body.postIds.length === 0) {
      throw ApiError.badRequest(
        'no_posts_named',
        'A named-posts licence has to name the posts it covers.',
      );
    }
    if (body.endsAt !== null && body.endsAt.getTime() <= body.startsAt.getTime()) {
      throw ApiError.badRequest('bad_dates', 'The licence must end after it starts.');
    }

    // Posts must belong to this creator on this campaign. Naming somebody
    // else's post in a licence request is how a brand ends up using footage
    // nobody agreed to hand over.
    if (body.postIds.length > 0) {
      const count = await PostModel.countDocuments({
        _id: { $in: body.postIds.map((id) => new Types.ObjectId(id)) },
        creatorId,
        campaignId,
      });
      if (count !== body.postIds.length) {
        throw ApiError.badRequest(
          'posts_not_theirs',
          'Some of those posts are not this creator’s work on this campaign.',
        );
      }
    }

    const existing = await ContentLicenseModel.findOne({ campaignId, creatorId });

    /**
     * A granted licence is never edited into a different one.
     *
     * Changing the terms under a creator who already agreed would make the
     * record say they consented to something they never saw. New terms need a
     * fresh request, which means withdrawing the old licence first.
     */
    if (existing?.grantedAt && !existing.revokedAt) {
      throw ApiError.conflict(
        'already_granted',
        'This creator has already granted a licence for this campaign. Withdraw it before proposing different terms.',
      );
    }

    const termsSha256 = hashTerms(body);

    const doc = await ContentLicenseModel.findOneAndUpdate(
      { campaignId, creatorId },
      {
        $set: {
          brandId,
          scope: body.scope,
          postIds: body.postIds.map((id) => new Types.ObjectId(id)),
          permittedUses: body.permittedUses,
          territory: body.territory,
          startsAt: body.startsAt,
          endsAt: body.endsAt,
          nameAndLikenessPermitted: body.nameAndLikenessPermitted,
          modificationPermitted: body.modificationPermitted,
          whitelistingPermitted: body.whitelistingPermitted,
          licenseFeeMinor: body.licenseFeeMinor,
          currency: body.currency,
          notes: body.notes,
          requestedByOperatorId: operator._id,
          requestedAt: new Date(),
          termsSha256,
          // A re-request clears any previous withdrawal; the creator is being
          // asked afresh.
          grantedAt: null,
          grantMethod: null,
          grantIpHash: null,
          revokedAt: null,
          revokedReason: null,
        },
      },
      { upsert: true, new: true },
    );

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.licenceRequested,
      subjectKind: 'ContentLicense',
      subjectId: doc._id,
      detail: {
        campaignId: campaignId.toString(),
        creatorId: creatorId.toString(),
        permittedUses: body.permittedUses,
        territory: body.territory,
        perpetual: body.endsAt === null,
        termsSha256,
      },
      ipHash: hashIp(clientIp(req)),
    });

    res.status(201).json({ id: doc._id.toString(), termsSha256, state: 'awaiting_creator' });
  }),
);

/* ---------------------------------------------------------------- list */

licensingRouter.get(
  '/campaigns/:campaignId/licences',
  asyncRoute(async (req, res) => {
    const campaignIdRaw = req.params.campaignId;
    if (typeof campaignIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(campaignIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid campaign id.');
    }
    const campaignId = new Types.ObjectId(campaignIdRaw);
    const now = new Date();

    const [licences, joins] = await Promise.all([
      ContentLicenseModel.find({ campaignId }).lean(),
      CampaignCreatorModel.find({ campaignId }).lean(),
    ]);

    const creators = await CreatorModel.find({ _id: { $in: joins.map((j) => j.creatorId) } })
      .select('displayName handles')
      .lean();
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));
    const licenceByCreator = new Map(licences.map((l) => [l.creatorId.toString(), l]));

    /**
     * Every participant is listed, including those with no licence at all.
     *
     * A list of only the licences that exist reads as "these are the rights we
     * have"; a list of every creator with their status reads as "here is what
     * we do not have", which is the question an account manager is asking.
     */
    res.json({
      licences: joins.map((join) => {
        const creator = creatorById.get(join.creatorId.toString());
        const licence = licenceByCreator.get(join.creatorId.toString()) ?? null;
        const status = licenceStatus(toLicenceLike(licence), now);
        const attention = needsAttentionSoon(
          { licence: toLicenceLike(licence), authorisation: null },
          now,
        );

        return {
          campaignCreatorId: join._id.toString(),
          creatorId: join.creatorId.toString(),
          creatorName: creator?.displayName ?? null,
          handle: creator?.handles[0]?.handle ?? null,
          licenceId: licence?._id.toString() ?? null,
          state: status.state,
          summary: status.summary,
          usableNow: status.usableNow,
          daysUntilExpiry: status.daysUntilExpiry,
          isPerpetual: status.isPerpetual,
          permittedUses: licence?.permittedUses ?? [],
          permittedUseLabels: (licence?.permittedUses ?? []).map(
            (u) => USE_LABELS[u as PermittedUse] ?? u,
          ),
          territory: licence?.territory ?? [],
          scope: licence?.scope ?? null,
          postIds: (licence?.postIds ?? []).map((p) => p.toString()),
          startsAt: licence?.startsAt ?? null,
          endsAt: licence?.endsAt ?? null,
          grantedAt: licence?.grantedAt ?? null,
          revokedAt: licence?.revokedAt ?? null,
          requestedAt: licence?.requestedAt ?? null,
          licenseFeeMinor: licence?.licenseFeeMinor ?? null,
          currency: licence?.currency ?? null,
          whitelistingPermitted: licence?.whitelistingPermitted ?? false,
          modificationPermitted: licence?.modificationPermitted ?? false,
          nameAndLikenessPermitted: licence?.nameAndLikenessPermitted ?? false,
          needsAttention: attention.urgent,
          attentionReasons: attention.reasons,
        };
      }),
      vocabulary: {
        uses: PERMITTED_USES.map((u) => ({ key: u, label: USE_LABELS[u] })),
        worldwide: WORLDWIDE,
      },
    });
  }),
);

/* --------------------------------------------------------- ad readiness */

/**
 * Which posts can actually be run as ads, and what is missing where they
 * cannot.
 *
 * Two separate permissions have to line up — the creator's licence and the
 * platform's authorisation code — and they fail independently. A week before a
 * campaign goes live, knowing WHICH one is missing is the whole question.
 */
licensingRouter.get(
  '/campaigns/:campaignId/ad-readiness',
  asyncRoute(async (req, res) => {
    const campaignIdRaw = req.params.campaignId;
    if (typeof campaignIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(campaignIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid campaign id.');
    }
    const campaignId = new Types.ObjectId(campaignIdRaw);
    const now = new Date();

    const posts = await PostModel.find({ campaignId })
      .select('_id creatorId platform format postedAt publicUrl adAuthorisations')
      .lean();
    const licences = await ContentLicenseModel.find({ campaignId }).lean();
    const licenceByCreator = new Map(licences.map((l) => [l.creatorId.toString(), l]));
    const creators = await CreatorModel.find({ _id: { $in: posts.map((p) => p.creatorId) } })
      .select('displayName handles')
      .lean();
    const creatorById = new Map(creators.map((c) => [c._id.toString(), c]));

    const rows = posts.map((post) => {
      const licence = licenceByCreator.get(post.creatorId.toString()) ?? null;
      const live = post.adAuthorisations.find((a) => a.revokedAt == null) ?? null;
      const readiness = adReadiness({
        licence: toLicenceLike(licence),
        authorisation: live
          ? {
              platform: live.platform,
              code: live.code,
              providedAt: live.providedAt,
              expiresAt: live.expiresAt ?? null,
              revokedAt: live.revokedAt ?? null,
            }
          : null,
        at: now,
      });
      const creator = creatorById.get(post.creatorId.toString());

      return {
        postId: post._id.toString(),
        creatorId: post.creatorId.toString(),
        creatorName: creator?.displayName ?? null,
        handle: creator?.handles[0]?.handle ?? null,
        platform: post.platform,
        format: post.format,
        postedAt: post.postedAt,
        publicUrl: post.publicUrl,
        ready: readiness.ready,
        blockers: readiness.blockers,
        whatIsNeeded: readiness.whatIsNeeded,
        adPlatform: live?.platform ?? null,
        codeExpiresAt: readiness.codeExpiresAt,
        daysUntilCodeExpiry: readiness.daysUntilCodeExpiry,
        /**
         * The code itself is returned only when everything lines up. An
         * expired or unlicensed code is not something an operator should be
         * able to copy out of a list and paste into an ads manager.
         */
        code: readiness.code,
      };
    });

    res.json({
      posts: rows,
      counts: {
        total: rows.length,
        ready: rows.filter((r) => r.ready).length,
        blocked: rows.filter((r) => !r.ready).length,
        expiringWithin14Days: rows.filter(
          (r) => r.daysUntilCodeExpiry !== null && r.daysUntilCodeExpiry <= 14 && r.ready,
        ).length,
      },
      platforms: AD_PLATFORMS,
    });
  }),
);

/* ------------------------------------------------------------- withdraw */

const revokeSchema = z.object({ reason: z.string().min(1, 'say why').max(400) });

/**
 * An operator can withdraw a licence, but cannot grant one.
 *
 * Withdrawal is asymmetric on purpose: stopping a use the creator no longer
 * wants is safe in a way that recording an agreement on their behalf is not.
 */
licensingRouter.post(
  '/licences/:licenceId/revoke',
  asyncRoute(async (req, res) => {
    const licenceIdRaw = req.params.licenceId;
    if (typeof licenceIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(licenceIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid licence id.');
    }
    const body = parseBody(revokeSchema, req);
    const { operator } = getOperator(req);

    const doc = await ContentLicenseModel.findOneAndUpdate(
      { _id: licenceIdRaw, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: body.reason } },
      { new: true },
    );
    if (!doc) throw ApiError.notFound('licence_not_found', 'No such licence still in force.');

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.licenceRevoked,
      subjectKind: 'ContentLicense',
      subjectId: doc._id,
      detail: { reason: body.reason, creatorId: doc.creatorId.toString() },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true, revokedAt: doc.revokedAt });
  }),
);
