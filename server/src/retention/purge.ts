import { CampaignCreatorModel, CampaignModel, ContentLicenseModel, CreatorModel, MagicLinkModel, PostModel, SessionModel } from '../db/models/index.js';
import { getStorage } from '../storage/index.js';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from '../lib/audit.js';

/**
 * Automated retention purge.
 *
 * A retention policy that exists only in a document is not a retention policy.
 * This is the code that actually enforces the figures CONSENT.md commits to.
 *
 * What goes: profile fields, posts, metrics, screenshots, participation rows,
 * licences. What stays, and only until its own longer horizon: the consent
 * tombstone — the dated note that consent was given and when it ended. Deleting
 * that would leave us unable to answer for having held the rest.
 */

export interface PurgeResult {
  readonly dryRun: boolean;
  readonly creatorsPurged: number;
  readonly postsDeleted: number;
  readonly screenshotsDeleted: number;
  readonly screenshotsFailed: string[];
  readonly consentRecordsExpired: number;
  readonly details: { creatorId: string; displayName: string; lastCampaignEndedAt: Date | null }[];
}

/**
 * Purges creators whose last campaign ended more than RETENTION_MONTHS ago.
 *
 * Anchored on the last campaign's END date, not on the creator's last activity:
 * a creator who joined one campaign two years ago and nothing since should fall
 * out of retention, and one who is still working should not, regardless of how
 * recently they happened to open a link.
 */
export async function purgeExpiredData(dryRun = true): Promise<PurgeResult> {
  const env = loadEnv();
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - env.RETENTION_MONTHS);

  const consentCutoff = new Date(now);
  consentCutoff.setFullYear(consentCutoff.getFullYear() - env.CONSENT_RETENTION_YEARS);

  const creators = await CreatorModel.find({ status: { $ne: 'removed' } }).lean();
  const storage = getStorage();

  const details: PurgeResult['details'] = [];
  const screenshotsFailed: string[] = [];
  let postsDeleted = 0;
  let screenshotsDeleted = 0;

  for (const creator of creators) {
    const joins = await CampaignCreatorModel.find({ creatorId: creator._id }).lean();

    // A creator on no campaign at all is anchored on when they joined; without
    // that, someone invited and never used would be retained forever.
    let lastEnd: Date | null = null;
    if (joins.length > 0) {
      const campaigns = await CampaignModel.find({ _id: { $in: joins.map((j) => j.campaignId) } })
        .select('endDate')
        .lean();
      for (const campaign of campaigns) {
        if (lastEnd === null || campaign.endDate > lastEnd) lastEnd = campaign.endDate;
      }
    } else {
      lastEnd = creator.joinedAt ?? creator.createdAt ?? null;
    }

    if (lastEnd === null || lastEnd > cutoff) continue;

    details.push({
      creatorId: creator._id.toString(),
      displayName: creator.displayName,
      lastCampaignEndedAt: lastEnd,
    });

    const posts = await PostModel.find({ creatorId: creator._id }).lean();
    const keys = posts
      .map((p) => p.extraction?.sourceImageKey)
      .filter((k): k is string => typeof k === 'string' && k.length > 0);

    if (dryRun) {
      postsDeleted += posts.length;
      screenshotsDeleted += keys.length;
      continue;
    }

    const results = await Promise.allSettled(keys.map((k) => storage.deleteObject(k)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') screenshotsFailed.push(keys[i] ?? 'unknown');
      else screenshotsDeleted += 1;
    });

    await PostModel.deleteMany({ creatorId: creator._id });
    await CampaignCreatorModel.deleteMany({ creatorId: creator._id });
    await ContentLicenseModel.deleteMany({ creatorId: creator._id });
    await MagicLinkModel.deleteMany({ creatorId: creator._id });
    await SessionModel.deleteMany({ creatorId: creator._id });
    postsDeleted += posts.length;

    await CreatorModel.updateOne(
      { _id: creator._id },
      {
        $set: {
          status: 'removed',
          displayName: 'Purged (retention)',
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
        },
      },
    );
  }

  // The consent tombstone outlives the data it covers, but not forever.
  const expiredConsents = await CreatorModel.countDocuments({
    'consent.grantedAt': { $lt: consentCutoff },
  });
  if (!dryRun && expiredConsents > 0) {
    await CreatorModel.updateMany(
      { 'consent.grantedAt': { $lt: consentCutoff } },
      { $set: { consent: null } },
    );
  }

  if (!dryRun) {
    await recordAudit({
      actorKind: 'system',
      actorLabel: 'retention purge',
      action: AUDIT.retentionPurge,
      detail: {
        retentionMonths: env.RETENTION_MONTHS,
        creatorsPurged: details.length,
        postsDeleted,
        screenshotsDeleted,
        screenshotsFailed,
        consentRecordsExpired: expiredConsents,
      },
    });

    if (screenshotsFailed.length > 0) {
      // Named, not counted: an object that outlived its retention horizon is a
      // compliance problem someone has to go and fix by hand.
      console.error(
        `[retention] ${screenshotsFailed.length} screenshots survived the purge and need manual removal:`,
        screenshotsFailed,
      );
    }
  }

  return {
    dryRun,
    creatorsPurged: details.length,
    postsDeleted,
    screenshotsDeleted,
    screenshotsFailed,
    consentRecordsExpired: expiredConsents,
    details,
  };
}
