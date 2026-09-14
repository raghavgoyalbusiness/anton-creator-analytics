import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  MAX_TRUST_DOMAINS_PER_CREATOR,
  MIN_SAMPLE_FOR_DOMAIN_RATE,
  SEED_TRUST_DOMAINS,
  isSeedTrustDomain,
  labelForTrustDomain,
  validateTrustDomains,
} from '@anton/shared';
import { CampaignModel, CreatorModel } from '../db/models/index.js';
import { getOperator, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { buildTrustDomainSection } from '../reporting/trust-domains.js';

export const trustDomainsRouter: Router = Router();
trustDomainsRouter.use(requireOperator);

/**
 * Trust domain tagging.
 *
 * A dedicated route rather than a field on the general creator PATCH, because
 * the value has to be folded, deduplicated and capped before it is stored, and
 * because who made the judgement is part of the record.
 */

/** The vocabulary: seeded domains first, then custom ones already in use. */
trustDomainsRouter.get(
  '/trust-domains',
  asyncRoute(async (_req, res) => {
    const inUse = await CreatorModel.aggregate<{ _id: string; n: number }>([
      { $unwind: '$trustDomains' },
      { $group: { _id: '$trustDomains', n: { $sum: 1 } } },
    ]);
    const countFor = new Map(inUse.map((r) => [r._id, r.n]));

    const seeded = SEED_TRUST_DOMAINS.map((key) => ({
      key,
      label: labelForTrustDomain(key),
      isSeed: true,
      creators: countFor.get(key) ?? 0,
    }));
    const custom = inUse
      .filter((r) => !isSeedTrustDomain(r._id))
      .map((r) => ({ key: r._id, label: labelForTrustDomain(r._id), isSeed: false, creators: r.n }))
      .sort((a, b) => b.creators - a.creators);

    res.json({
      domains: [...seeded, ...custom],
      maxPerCreator: MAX_TRUST_DOMAINS_PER_CREATOR,
      minimumSampleForRate: MIN_SAMPLE_FOR_DOMAIN_RATE,
    });
  }),
);

const tagSchema = z.object({ domains: z.array(z.string().max(60)).max(10) });

trustDomainsRouter.put(
  '/creators/:creatorId/trust-domains',
  asyncRoute(async (req, res) => {
    const creatorIdRaw = req.params.creatorId;
    if (typeof creatorIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(creatorIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid creator id.');
    }
    const body = parseBody(tagSchema, req);
    const { operator } = getOperator(req);

    const validation = validateTrustDomains(body.domains);
    if (!validation.ok) {
      throw ApiError.badRequest('bad_trust_domains', validation.problems.join('; '), {
        problems: validation.problems,
      });
    }

    const before = await CreatorModel.findById(creatorIdRaw).select('trustDomains').lean();
    if (!before) throw ApiError.notFound('creator_not_found', 'No such creator.');

    await CreatorModel.updateOne(
      { _id: creatorIdRaw },
      {
        $set: {
          trustDomains: validation.domains,
          trustDomainsTaggedAt: new Date(),
          trustDomainsTaggedByOperatorId: operator._id,
        },
      },
    );

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.trustDomainsTagged,
      subjectKind: 'Creator',
      subjectId: new Types.ObjectId(creatorIdRaw),
      // Before and after, because a retag silently moves this creator's
      // orders from one domain's sample to another's.
      detail: { before: before.trustDomains ?? [], after: validation.domains },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({
      domains: validation.domains.map((key) => ({ key, label: labelForTrustDomain(key) })),
    });
  }),
);

trustDomainsRouter.get(
  '/campaigns/:campaignId/trust-domains',
  asyncRoute(async (req, res) => {
    const campaignIdRaw = req.params.campaignId;
    if (typeof campaignIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(campaignIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid campaign id.');
    }
    const campaign = await CampaignModel.findById(campaignIdRaw)
      .select('_id brandId startDate endDate currency')
      .lean();
    if (!campaign) throw ApiError.notFound('campaign_not_found', 'No such campaign.');

    res.json(
      await buildTrustDomainSection({
        campaignId: campaign._id,
        brandId: campaign.brandId,
        currency: campaign.currency,
      }),
    );
  }),
);
