/** Read-back check: proves the seeded data satisfies the invariants we claim. */
import { connectDb, disconnectDb } from '../db/connect.js';
import { CampaignModel, CreatorModel, PostModel } from '../db/models/index.js';
import { isBrandReportable, overridesByField } from '@anton/shared';

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  results.push([name, ok, detail]);
};

await connectDb();

const posts = await PostModel.find({}).lean();
const creators = await CreatorModel.find({}).lean();
const campaigns = await CampaignModel.find({}).lean();

check('posts exist', posts.length > 0, `${posts.length} posts`);

check(
  'every screenshot post carries an extraction record',
  posts.every((p) => p.metricSource !== 'screenshot' || p.extraction != null),
);

check(
  'every extraction stores rawResponse verbatim, parsed or not',
  posts.every((p) => typeof p.extraction?.rawResponse === 'string' && p.extraction.rawResponse.length > 0),
);

check(
  'unparseable extractions are never auto-accepted',
  posts.filter((p) => p.extraction?.parseOk === false).every((p) => p.extraction?.status === 'needs_review'),
  `${posts.filter((p) => p.extraction?.parseOk === false).length} unparseable`,
);

const autoAccepted = posts.filter((p) => p.extraction?.status === 'auto_accepted');
check(
  'no auto-accepted post carries a failing plausibility violation',
  autoAccepted.every((p) => (p.extraction?.plausibility.violations ?? []).every((v) => v.severity !== 'fail')),
  `${autoAccepted.length} auto-accepted`,
);

check(
  'no auto-accepted post has a field below 0.85 confidence',
  autoAccepted.every((p) => {
    const conf = p.extraction?.fieldConfidence;
    if (!conf) return false;
    return Object.values(conf).every((c) => c === null || c === undefined || c >= 0.85);
  }),
);

const withOverrides = posts.filter((p) => p.manualOverrides.length > 0);
check(
  'every override records from, to, who and when',
  withOverrides.every((p) =>
    p.manualOverrides.every((o) => o.by != null && o.at instanceof Date && o.field != null),
  ),
  `${withOverrides.length} posts with overrides`,
);

check(
  'every overridden post was verified by a named operator',
  withOverrides.every((p) => p.verifiedByOperatorId != null && p.verifiedAt != null),
);

check(
  'overridesByField() collapses to the brief Record shape',
  withOverrides.every((p) => {
    const byField = overridesByField(
      p.manualOverrides.map((o) => ({
        field: o.field,
        from: o.from ?? null,
        to: o.to ?? null,
        by: String(o.by),
        at: o.at,
        reason: o.reason ?? null,
      })),
    );
    return Object.keys(byField).length > 0;
  }),
);

const reportable = posts.filter((p) =>
  isBrandReportable({
    metricSource: p.metricSource,
    extraction: p.extraction == null ? null : { status: p.extraction.status },
  } as Parameters<typeof isBrandReportable>[0]),
);
check(
  'needs_review posts are excluded from brand-reportable set',
  reportable.every((p) => p.extraction?.status !== 'needs_review'),
  `${reportable.length}/${posts.length} reportable`,
);

check(
  'every post links to a source image key',
  posts.every((p) => (p.extraction?.sourceImageKey.length ?? 0) > 0),
);

check(
  'every post resolves to a real creator and campaign',
  posts.every(
    (p) =>
      creators.some((c) => String(c._id) === String(p.creatorId)) &&
      campaigns.some((c) => String(c._id) === String(p.campaignId)),
  ),
);

check(
  'no post predates its campaign start without being flagged',
  posts.every((p) => {
    const campaign = campaigns.find((c) => String(c._id) === String(p.campaignId));
    if (!campaign) return false;
    if (p.postedAt.getTime() >= campaign.startDate.getTime()) return true;
    return (p.extraction?.plausibility.violations ?? []).some(
      (v) => v.rule === 'posted_at_before_campaign_start',
    );
  }),
);

check(
  'every creator has a follower snapshot predating every one of their posts',
  posts.every((p) => {
    const creator = creators.find((c) => String(c._id) === String(p.creatorId));
    return (creator?.followerSnapshots ?? []).some((s) => s.capturedAt.getTime() <= p.postedAt.getTime());
  }),
);

const unreported = campaigns.flatMap((c) => c.discountCodes).filter((d) => d.reportedRedemptions === null);
check(
  'discount codes with no brand report stay null, never zero',
  unreported.every((d) => d.reportedRedemptions === null && d.reportedRevenue === null),
  `${unreported.length} codes awaiting brand data`,
);

check(
  'money is only ever whole minor units',
  campaigns.every(
    (c) =>
      Number.isInteger(c.budgetTotal.amountMinor) &&
      Number.isInteger(c.defaultPerCreatorRate.amountMinor) &&
      c.discountCodes.every((d) => d.reportedRevenue == null || Number.isInteger(d.reportedRevenue.amountMinor)),
  ),
);

check(
  'no raw IP is stored: consent holds only a 64-char hash',
  creators.every((c) => c.consent == null || /^[a-f0-9]{64}$/.test(c.consent.ipHash)),
);

let failures = 0;
for (const [name, ok, detail] of results) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} invariants hold`);

await disconnectDb();
process.exitCode = failures > 0 ? 1 : 0;
