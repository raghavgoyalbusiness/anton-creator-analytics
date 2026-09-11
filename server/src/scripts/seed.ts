/**
 * Seeds a realistic dataset.
 *
 * Deterministic by construction: a fixed-seed PRNG and a fixed clock, so the
 * same command produces byte-identical data every run. That matters because
 * the verification queue and the brand report are built against this data, and
 * a screenshot of "yesterday's numbers" should still match today.
 *
 *   npm run db:seed          insert if the database is empty
 *   npm run db:reset         drop everything first, then insert
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import {
  EMPTY_METRICS,
  METRIC_KEYS,
  evaluatePlausibility,
  followerCountAsOf,
  normaliseStub,
  normaliseTypedCode,
  routeByConfidence,
  type CampaignCreatorStatus,
  type FollowerSnapshot,
  type MetricKey,
  type Platform,
  type PostFormat,
  type PostMetrics,
} from '@anton/shared';
import { connectDb, disconnectDb } from '../db/connect.js';
import { IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { runAttribution } from '../attribution/run.js';
import { postCommission } from '../commission/post.js';
import {
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  MagicLinkModel,
  OperatorModel,
  PostModel,
  ShareLinkModel,
} from '../db/models/index.js';
import { loadEnv } from '../config/env.js';
import { hashIp, loadConsentDocument } from '../config/consent.js';
import { generateRecoveryCodes, hashPassword, totpUri } from '../lib/operator-session.js';
import { getStorage } from '../storage/index.js';
import { renderSyntheticPanel } from './seed-images.js';

/* ------------------------------------------------------------ determinism */

/** mulberry32: small, fast, reproducible. Not for anything security-bearing. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = makeRng(20260823);
const int = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T,>(items: readonly T[]): T => {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick() from an empty list');
  return item;
};
const chance = (p: number): boolean => rng() < p;

/** Fixed clock. Everything is relative to this, never to the real now(). */
const NOW = new Date('2026-08-23T10:00:00.000Z');
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/* ------------------------------------------------------------- vocabulary */

const NICHES = [
  'skincare', 'fitness', 'home-cooking', 'sustainable-fashion', 'student-life',
  'budget-travel', 'plant-parenting', 'running', 'baking', 'thrifting',
  'mens-grooming', 'yoga', 'gaming', 'book-tok', 'coffee',
] as const;

const CITIES: readonly [string, string][] = [
  ['London', 'GB'], ['Manchester', 'GB'], ['Bristol', 'GB'], ['Leeds', 'GB'],
  ['Glasgow', 'GB'], ['Birmingham', 'GB'], ['Cardiff', 'GB'], ['Brighton', 'GB'],
  ['Nottingham', 'GB'], ['Sheffield', 'GB'],
];

const FIRST = ['amara', 'joss', 'priya', 'tom', 'nia', 'reuben', 'esme', 'kai', 'imogen', 'dev',
  'freya', 'obi', 'lucia', 'harun', 'saoirse', 'milo', 'zainab', 'callum', 'yuki', 'rosa',
  'ade', 'lena', 'finn', 'maya', 'oscar', 'iris', 'jonah', 'talia', 'rex', 'nadia',
  'sol', 'bea', 'omar', 'wren', 'jude', 'anouk', 'levi', 'clio', 'ravi', 'elsie'];

const LAST = ['okafor', 'bell', 'nair', 'hartley', 'quinn', 'adeyemi', 'crawford', 'lin',
  'whitfield', 'shah', 'nilsson', 'eze', 'moretti', 'yilmaz', 'byrne', 'castellan',
  'rahman', 'doyle', 'tanaka', 'delgado'];

const ANGLES = ['before-after', 'unboxing', 'get-ready-with-me', 'day-in-the-life',
  'honest-review', 'three-ways-to-use', 'problem-solution', 'routine-swap'];

const HOOKS = [
  'I was NOT expecting this to work',
  'Three weeks in and here is the honest verdict',
  'Stop buying this until you watch this',
  'The one step everyone skips',
  'My skin has never behaved like this',
  'Testing the viral one so you do not have to',
  'This replaced four things in my bathroom',
  'Nobody talks about the second week',
];

const CAPTIONS = [
  'Genuinely surprised by this one. Full thoughts in the video.',
  'Gifted, but I would have bought it. Code in bio.',
  'Week three update as promised.',
  'Not sponsored to say this bit, but here we are.',
  'Ask me anything in the comments, I read them all.',
];

/* --------------------------------------------------------------- creators */

interface SeededCreator {
  readonly _id: Types.ObjectId;
  readonly displayName: string;
  readonly handle: string;
  readonly platform: Platform;
  readonly snapshots: FollowerSnapshot[];
}

function buildCreators(
  count: number,
  consentDoc: { version: string; sha256: string },
): {
  docs: Record<string, unknown>[];
  index: SeededCreator[];
} {
  const docs: Record<string, unknown>[] = [];
  const index: SeededCreator[] = [];
  const usedHandles = new Set<string>();

  for (let i = 0; i < count; i += 1) {
    const first = FIRST[i % FIRST.length] ?? 'creator';
    const last = pick(LAST);
    const displayName = `${first[0]?.toUpperCase()}${first.slice(1)} ${last[0]?.toUpperCase()}${last.slice(1)}`;

    let handle = `${first}.${last}`;
    let suffix = 1;
    while (usedHandles.has(handle)) {
      suffix += 1;
      handle = `${first}.${last}${suffix}`;
    }
    usedHandles.add(handle);

    const platform: Platform = chance(0.62) ? 'instagram' : 'tiktok';
    // Micro and nano only: 800 to 78,000. The whole thesis is this band.
    const currentFollowers = int(800, 78_000);
    const [city, country] = pick(CITIES);

    /**
     * Three snapshots over six months, growing. The oldest predates every post
     * in the seed so the follower-multiple rule always has a value to use.
     */
    const snapshots: FollowerSnapshot[] = [
      { platform, count: Math.round(currentFollowers * 0.72), capturedAt: daysAgo(180), source: 'manual' },
      { platform, count: Math.round(currentFollowers * 0.89), capturedAt: daysAgo(75), source: 'manual' },
      { platform, count: currentFollowers, capturedAt: daysAgo(6), source: 'manual' },
    ];

    const _id = new Types.ObjectId();
    const status = i < 3 ? 'invited' : chance(0.06) ? 'paused' : 'active';
    const hasConsent = status !== 'invited';
    const joined = daysAgo(int(20, 200));

    docs.push({
      _id,
      displayName,
      email: `${handle.replace(/\./g, '')}@example.com`,
      handles: [
        {
          platform,
          handle,
          platformUserId: chance(0.3) ? String(int(10_000_000, 99_999_999)) : null,
          profileUrl:
            platform === 'instagram'
              ? `https://www.instagram.com/${handle}/`
              : `https://www.tiktok.com/@${handle}`,
        },
      ],
      followerSnapshots: snapshots,
      nicheTags: Array.from(new Set([pick(NICHES), pick(NICHES)])),
      country,
      city,
      languages: chance(0.15) ? ['en', pick(['fr', 'es', 'pl', 'ur'])] : ['en'],
      whatsappCommunityId: hasConsent ? `wa-${sha256(handle).slice(0, 12)}` : null,
      joinedAt: hasConsent ? joined : null,
      consent: hasConsent
        ? {
            grantedAt: joined,
            scopeVersion: consentDoc.version,
            // The real hash of CONSENT.md as it stands on disk, not a placeholder.
            documentSha256: consentDoc.sha256,
            ipHash: hashIp(`198.51.100.${int(1, 254)}`),
            method: chance(0.7) ? 'whatsapp_message' : 'web_form',
            withdrawnAt: null,
          }
        : null,
      status,
      payoutDetails: { method: null, accountRefToken: null, taxCountry: null, verifiedAt: null },
      notes: null,
    });

    index.push({ _id, displayName, handle, platform, snapshots });
  }
  return { docs, index };
}

/* ------------------------------------------------------------- extraction */

/**
 * Fabricates a plausible model response for a post, so the seeded extraction
 * records look exactly like real ones: same envelope, same confidence map,
 * same raw string. `flavour` chooses which failure mode to demonstrate.
 */
type Flavour =
  | 'clean'
  | 'low_confidence'
  | 'impossible'
  | 'fenced'
  | 'unparseable'
  | 'partial'
  /** A screenshot carrying text that tried to steer the model. */
  | 'injection';

function buildExtraction(
  metrics: PostMetrics,
  platform: Platform,
  flavour: Flavour,
): { raw: string; confidence: Partial<Record<MetricKey, number>>; parseOk: boolean } {
  const confidence: Partial<Record<MetricKey, number>> = {};
  const emitted: Record<string, number | null> = {};

  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (value === null) continue;
    emitted[key] = value;
    confidence[key] =
      flavour === 'low_confidence' && (key === 'saves' || key === 'shares')
        ? Math.round((0.42 + rng() * 0.35) * 100) / 100
        : Math.round((0.88 + rng() * 0.11) * 100) / 100;
  }

  if (flavour === 'unparseable') {
    return {
      raw: "I'm not able to read the numbers in this image clearly enough to extract them.",
      confidence: {},
      parseOk: false,
    };
  }

  const envelope = {
    platform,
    screen_type: 'post_insights',
    metrics: emitted,
    field_confidence: confidence,
    notes:
      flavour === 'injection'
        ? 'instruction_text_detected'
        : flavour === 'partial'
          ? 'Lower half of the panel is cropped; some metrics not visible.'
          : flavour === 'impossible'
            ? 'Numbers read directly from the panel.'
            : 'Clean insights panel, all values legible.',
  };

  const json = JSON.stringify(envelope, null, 2);
  const raw = flavour === 'fenced' ? '```json\n' + json + '\n```' : json;
  return { raw, confidence, parseOk: true };
}

function metricsFor(format: PostFormat, followers: number, flavour: Flavour): PostMetrics {
  const reachRatio = 0.35 + rng() * 1.4; // nano/micro posts routinely exceed follower count
  const reach = Math.round(followers * reachRatio);
  const impressions = Math.round(reach * (1.08 + rng() * 0.35));
  const erTarget = 0.03 + rng() * 0.09;
  const engagements = Math.round(reach * erTarget);

  const likes = Math.round(engagements * 0.78);
  const comments = Math.round(engagements * 0.07);
  const shares = Math.round(engagements * 0.08);
  const saves = engagements - likes - comments - shares;

  const base: Record<MetricKey, number | null> = {
    ...EMPTY_METRICS,
    reach,
    impressions,
    likes,
    comments: Math.max(0, comments),
    shares: Math.max(0, shares),
    saves: Math.max(0, saves),
    profileVisits: Math.round(reach * (0.01 + rng() * 0.03)),
    linkClicks: null,
    videoViews: null,
    watchTimeSeconds: null,
    followsFromPost: Math.round(reach * (0.001 + rng() * 0.004)),
  };

  if (format === 'reel' || format === 'tiktok_video') {
    base.videoViews = Math.round(impressions * (0.9 + rng() * 0.15));
    base.watchTimeSeconds = Math.round((base.videoViews ?? 0) * (2 + rng() * 9));
  }
  if (format === 'story') {
    base.linkClicks = Math.round(reach * (0.005 + rng() * 0.02));
    base.comments = null;
    base.saves = null;
    base.videoViews = null;
    base.watchTimeSeconds = null;
  }

  if (flavour === 'partial') {
    base.saves = null;
    base.profileVisits = null;
    base.followsFromPost = null;
  }

  if (flavour === 'impossible') {
    // A 'K' suffix misread as a raw number: reach reads 1000x too high.
    // This is the single most common real extraction failure.
    base.reach = (base.reach ?? 0) * 1000;
    base.impressions = base.reach;
  }

  return base as PostMetrics;
}

/* -------------------------------------------------------------------- run */

async function seed(reset: boolean): Promise<void> {
  const env = loadEnv();
  await connectDb();

  if (reset) {
    // Listed explicitly rather than looped over an array of models: the models
    // have different document types, so a shared array collapses deleteMany
    // into an uncallable union.
    await Promise.all([
      OperatorModel.deleteMany({}),
      BrandModel.deleteMany({}),
      CreatorModel.deleteMany({}),
      CampaignModel.deleteMany({}),
      CampaignCreatorModel.deleteMany({}),
      PostModel.deleteMany({}),
      MagicLinkModel.deleteMany({}),
      ShareLinkModel.deleteMany({}),
      TrackingAssetModel.deleteMany({}),
      OrderModel.deleteMany({}),
      IngestBatchModel.deleteMany({}),
      AttributionModel.deleteMany({}),
      AttributionConflictModel.deleteMany({}),
      // The ledger model refuses deleteMany by design; a reset goes round it
      // at the driver rather than weakening the guarantee for everyone else.
      CommissionEntryModel.collection.deleteMany({}),
      PaymentRecordModel.deleteMany({}),
    ]);
    console.log('[seed] cleared all collections');
  } else {
    const existing = await CreatorModel.estimatedDocumentCount();
    if (existing > 0) {
      console.log(`[seed] ${existing} creators already present; pass --reset to replace. Nothing done.`);
      await disconnectDb();
      return;
    }
  }

  /* Operator */
  const operatorId = new Types.ObjectId();
  const DEV_PASSWORD = 'anton-dev-password';
  // Fixed so the authenticator entry survives a reseed. Development only: the
  // production guard in env.ts refuses to boot with dev defaults in place.
  const DEV_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
  const recovery = await generateRecoveryCodes(4);

  await OperatorModel.create({
    _id: operatorId,
    email: 'ops@anton.example',
    displayName: 'Anton Operator',
    passwordHash: await hashPassword(DEV_PASSWORD),
    role: 'owner',
    lastLoginAt: daysAgo(1),
    totpSecret: DEV_TOTP_SECRET,
    totpEnrolledAt: daysAgo(60),
    recoveryCodeHashes: recovery.hashes,
  });

  /* Brands */
  const brandA = new Types.ObjectId();
  const brandB = new Types.ObjectId();
  await BrandModel.insertMany([
    {
      _id: brandA,
      name: 'Kelp & Co',
      websiteUrl: 'https://kelpandco.example',
      logoImageKey: null,
      primaryColorHex: '#1F5F4A',
      contactEmail: 'marketing@kelpandco.example',
      country: 'GB',
      defaultCurrency: 'GBP',
    },
    {
      _id: brandB,
      name: 'Northbound Coffee',
      websiteUrl: 'https://northbound.example',
      logoImageKey: null,
      primaryColorHex: '#7A3B1F',
      contactEmail: 'hello@northbound.example',
      country: 'GB',
      defaultCurrency: 'GBP',
    },
  ]);

  /* Creators */
  const consentDoc = await loadConsentDocument();
  console.log(`[seed] consent ${consentDoc.version} sha256 ${consentDoc.sha256.slice(0, 16)}...`);
  const { docs: creatorDocs, index: creators } = buildCreators(56, consentDoc);
  await CreatorModel.insertMany(creatorDocs);
  console.log(`[seed] ${creatorDocs.length} creators`);

  /* Campaigns */
  const campaignA = new Types.ObjectId();
  const campaignB = new Types.ObjectId();
  const startA = daysAgo(45);
  const startB = daysAgo(12);

  const codesFor = (prefix: string, assignees: SeededCreator[]) =>
    assignees.map((c, i) => ({
      id: `code-${prefix}-${i}`,
      code: `${prefix}${c.handle.split('.')[0]?.toUpperCase().slice(0, 6)}10`,
      assignedCreatorId: c._id,
      issuedAt: daysAgo(46),
      expiresAt: daysAgo(-30),
      // Most brands never report back. That is the honest default, and the
      // report must say so rather than showing a zero.
      reportedRedemptions: i < 4 ? int(3, 41) : null,
      reportedRevenue: i < 4 ? { amountMinor: int(4_000, 68_000), currency: 'GBP' } : null,
      reportedAt: i < 4 ? daysAgo(3) : null,
      reportedBySource: i < 4 ? 'Shopify export, supplied by brand 2026-08-20' : null,
    }));

  const rosterA = creators.slice(0, 34);
  const rosterB = creators.slice(34, 50);

  await CampaignModel.insertMany([
    {
      _id: campaignA,
      brandId: brandA,
      name: 'Kelp & Co — Barrier Serum Launch',
      brief:
        'Show the serum inside an existing routine. Two weeks of use before filming. No before/after skin claims, no medical language. Must disclose gifting.',
      objective: 'Prove cost per engaged reach against a single mega-influencer buy.',
      status: 'live',
      platforms: ['instagram', 'tiktok'],
      startDate: startA,
      endDate: daysAgo(-15),
      deliverableSpec: [
        { format: 'reel', count: 1 },
        { format: 'story', count: 2 },
      ],
      compensationModel: 'hybrid',
      currency: 'GBP',
      budgetTotal: { amountMinor: 1_040_000, currency: 'GBP' },
      defaultPerCreatorRate: { amountMinor: 4_000, currency: 'GBP' },
      trackingLinks: rosterA.slice(0, 8).map((c, i) => ({
        id: `link-a-${i}`,
        label: `${c.displayName} — serum PDP`,
        destinationUrl: 'https://kelpandco.example/products/barrier-serum',
        utmSource: 'anton',
        utmMedium: 'creator',
        utmCampaign: 'barrier-serum-launch',
        utmContent: c.handle,
        assignedCreatorId: c._id,
        issuedAt: daysAgo(46),
      })),
      discountCodes: codesFor('KELP', rosterA.slice(0, 14)),
      megaBenchmark: {
        label: '1.4M-follower UK beauty creator, agency quote for one reel',
        quotedFee: { amountMinor: 1_800_000, currency: 'GBP' },
        quotedReach: 620_000,
        sourceNote:
          'Quote received by email from talent agency, 2026-07-14. Benchmark supplied by Anton; not a measured result.',
        enteredAt: daysAgo(30),
        enteredByOperatorId: operatorId,
      },
    },
    {
      _id: campaignB,
      brandId: brandB,
      name: 'Northbound — Autumn Roast',
      brief: 'Morning-routine framing. Show the grind and the pour. Gifted bags only, no fee.',
      objective: 'Seed the autumn blend with student-adjacent creators.',
      status: 'live',
      platforms: ['tiktok'],
      startDate: startB,
      endDate: daysAgo(-25),
      deliverableSpec: [{ format: 'tiktok_video', count: 1 }],
      compensationModel: 'gifted',
      currency: 'GBP',
      budgetTotal: { amountMinor: 96_000, currency: 'GBP' },
      defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
      trackingLinks: [],
      discountCodes: codesFor('NB', rosterB.slice(0, 6)),
      megaBenchmark: null,
    },
  ]);

  /* Joins */
  const joins: Record<string, unknown>[] = [];
  const assign = (
    roster: SeededCreator[],
    campaignId: Types.ObjectId,
    start: Date,
    rate: number,
    distribution: readonly CampaignCreatorStatus[],
  ): void => {
    roster.forEach((c, i) => {
      const status = distribution[i % distribution.length] ?? 'invited';
      const invitedAt = new Date(start.getTime() - 2 * 86_400_000);
      const responded = status === 'invited' ? null : new Date(invitedAt.getTime() + int(1, 4) * 86_400_000);
      const posted = ['posted', 'reported', 'paid'].includes(status)
        ? new Date(start.getTime() + int(2, 20) * 86_400_000)
        : null;
      joins.push({
        campaignId,
        creatorId: c._id,
        status,
        agreedRate: rate > 0 ? { amountMinor: rate, currency: 'GBP' } : null,
        productShipped: ['shipped', 'posted', 'reported', 'paid'].includes(status),
        shippedAt: ['shipped', 'posted', 'reported', 'paid'].includes(status)
          ? new Date(invitedAt.getTime() + 5 * 86_400_000)
          : null,
        trackingNumber: ['shipped', 'posted', 'reported', 'paid'].includes(status)
          ? `RM${int(100_000_000, 999_999_999)}GB`
          : null,
        assignedDiscountCodeId: null,
        assignedTrackingLinkId: null,
        invitedAt,
        respondedAt: responded,
        firstPostedAt: posted,
        lastSubmissionAt: status === 'reported' || status === 'paid' ? posted : null,
        paidAt: status === 'paid' ? daysAgo(4) : null,
        history: [{ from: null, to: 'invited', at: invitedAt, by: String(operatorId), note: null }],
      });
    });
  };

  // Deliberately uneven: a real campaign always has stragglers, and the nudge
  // list is only testable if some creators are genuinely stuck.
  assign(rosterA, campaignA, startA, 4_000, [
    'reported', 'reported', 'paid', 'posted', 'accepted', 'reported',
    'shipped', 'declined', 'reported', 'posted', 'invited', 'paid', 'accepted',
  ]);
  assign(rosterB, campaignB, startB, 0, [
    'accepted', 'shipped', 'posted', 'reported', 'invited', 'shipped',
  ]);
  await CampaignCreatorModel.insertMany(joins);
  console.log(`[seed] ${joins.length} campaign-creator joins`);

  /* Posts */
  const posts: Record<string, unknown>[] = [];
  // Weighted so the verification queue has enough in it to exercise a
  // keyboard-driven workflow, while auto-accept still dominates as it would in
  // production. Every failure mode appears at least twice.
  const flavourCycle: Flavour[] = [
    'clean', 'low_confidence', 'clean', 'impossible', 'clean', 'fenced',
    'low_confidence', 'clean', 'partial', 'unparseable', 'clean', 'injection',
    'clean', 'low_confidence', 'partial', 'clean', 'unparseable', 'clean',
    'injection', 'clean', 'impossible', 'clean',
  ];
  let flavourAt = 0;
  let reviewedCounter = 0;

  const makePosts = (
    roster: SeededCreator[],
    campaignId: Types.ObjectId,
    campaignStart: Date,
    formats: readonly PostFormat[],
  ): void => {
    for (const creator of roster) {
      const join = joins.find(
        (j) => String(j.creatorId) === String(creator._id) && String(j.campaignId) === String(campaignId),
      );
      const status = join?.status as CampaignCreatorStatus | undefined;
      if (!status || !['posted', 'reported', 'paid'].includes(status)) continue;

      const postCount = formats.length === 1 ? 1 : int(1, 2);
      for (let p = 0; p < postCount; p += 1) {
        const flavour = flavourCycle[flavourAt % flavourCycle.length] ?? 'clean';
        flavourAt += 1;

        const format = pick(formats);
        const postedAt = new Date(
          campaignStart.getTime() + int(2, 22) * 86_400_000 + int(0, 23) * 3_600_000,
        );
        if (postedAt.getTime() > NOW.getTime()) continue;

        const followerSnap = followerCountAsOf(creator.snapshots, creator.platform, postedAt);
        const followers = followerSnap?.count ?? 5_000;
        const metrics = metricsFor(format, followers, flavour);
        const { raw, confidence, parseOk } = buildExtraction(metrics, creator.platform, flavour);

        // Exactly the pipeline the runtime uses. Seeded statuses are computed,
        // never hand-assigned, so the queue's contents are always consistent
        // with the rules as they currently stand.
        const storedMetrics: PostMetrics = parseOk ? metrics : EMPTY_METRICS;
        const plausibility = evaluatePlausibility({
          metrics: storedMetrics,
          postedAt,
          campaignStartDate: campaignStart,
          followerCountAtPost: followers,
          now: NOW,
        });
        const routing = routeByConfidence({
          metrics: storedMetrics,
          fieldConfidence: parseOk ? confidence : {},
          plausibility,
          screenType: 'post_insights',
        });

        const instructionTextDetected = flavour === 'injection';
        const injectionReasons = instructionTextDetected
          ? [
              'The model reported instruction-like text inside this image. It was told to ignore it, but this submission and this creator need a look.',
            ]
          : [];
        const submissionLagHours = int(1, 96);

        const needsHuman = routing.status === 'needs_review' || instructionTextDetected;
        // Deterministic rather than a coin flip: every third post that needs a
        // human is seeded as already worked through, so the dataset is
        // guaranteed to contain the verified-with-override state the audit
        // trail exists to demonstrate. A probability here can and did produce
        // runs with zero verified posts.
        if (needsHuman) reviewedCounter += 1;
        const alreadyVerified = needsHuman && reviewedCounter % 3 === 0;
        const finalStatus = !parseOk
          ? 'needs_review'
          : alreadyVerified
            ? 'verified'
            : needsHuman
              ? 'needs_review'
              : routing.status;

        const overrides =
          alreadyVerified && flavour === 'impossible'
            ? [
                {
                  field: 'reach' as MetricKey,
                  from: metrics.reach,
                  to: Math.round((metrics.reach ?? 0) / 1000),
                  by: operatorId,
                  at: new Date(postedAt.getTime() + 2 * 86_400_000),
                  reason: 'Model read the K suffix as a literal digit run. Corrected against the screenshot.',
                },
              ]
            : [];

        const correctedMetrics: PostMetrics =
          overrides.length > 0
            ? { ...storedMetrics, reach: overrides[0]?.to ?? storedMetrics.reach, impressions: overrides[0]?.to ?? storedMetrics.impressions }
            : storedMetrics;

        const imageKey = `creators/${creator._id.toHexString()}/${randomUUID()}.jpg`;

        posts.push({
          creatorId: creator._id,
          campaignId,
          platform: creator.platform,
          format,
          publicUrl:
            format === 'story'
              ? null
              : creator.platform === 'instagram'
                ? `https://www.instagram.com/p/${sha256(imageKey).slice(0, 11)}/`
                : `https://www.tiktok.com/@${creator.handle}/video/${int(7_000_000_000_000_000_000, 7_999_999_999_999_999_999)}`,
          postedAt,
          caption: pick(CAPTIONS),
          creativeAngleTags: [pick(ANGLES)],
          hookText: chance(0.7) ? pick(HOOKS) : null,
          metrics: correctedMetrics,
          metricSource: 'screenshot',
          extraction: {
            sourceImageKey: imageKey,
            sourceImageSha256: sha256(imageKey),
            extractedAt: new Date(postedAt.getTime() + 3_600_000),
            model: env.ANTHROPIC_MODEL,
            promptVersion: 'extract-v1',
            rawResponse: raw,
            parseOk,
            parseError: parseOk ? null : 'no JSON object found in model response',
            detectedPlatform: parseOk ? creator.platform : null,
            detectedScreenType: parseOk ? 'post_insights' : null,
            modelNotes: null,
            fieldConfidence: parseOk ? confidence : {},
            plausibility,
            status: finalStatus,
            routingReasons: parseOk
              ? [...injectionReasons, ...routing.reasons]
              : ['The model returned no parseable JSON for this image.'],
            instructionTextDetected,
            inputTokens: int(1_100, 1_900),
            outputTokens: int(120, 340),
          },
          trust: {
            submissionLagHours,
            withinSubmissionWindow: submissionLagHours <= 72,
            // Absence is normal for a screenshot and is not a red flag.
            exifPresent: false,
            exifCaptureTimestamp: null,
            flaggedForSpotAudit: chance(0.1),
            spotAuditOutcome: null,
            spotAuditAt: null,
            publicCrossCheck: { status: 'not_attempted', checkedAt: null, publicLikes: null, publicComments: null, divergenceRatio: null, note: null },
            historicalDeviation: null,
          },
          verifiedByOperatorId: alreadyVerified ? operatorId : null,
          verifiedAt: alreadyVerified ? new Date(postedAt.getTime() + 2 * 86_400_000) : null,
          rejectedReason: null,
          manualOverrides: overrides,
          submittedAt: new Date(postedAt.getTime() + 3_500_000),
        });
      }
    }
  };

  makePosts(rosterA, campaignA, startA, ['reel', 'story', 'feed', 'carousel']);
  makePosts(rosterB, campaignB, startB, ['tiktok_video']);
  await PostModel.insertMany(posts);
  console.log(`[seed] ${posts.length} posts`);

  // Write a synthetic panel per post so the verification queue actually has an
  // image to show. Clearly watermarked as sample data.
  const storage = getStorage();
  let written = 0;
  for (const post of posts) {
    const key = (post.extraction as { sourceImageKey: string }).sourceImageKey;
    const creator = creators.find((c) => String(c._id) === String(post.creatorId));
    const image = await renderSyntheticPanel({
      handle: creator?.handle ?? 'creator',
      platform: String(post.platform),
      format: String(post.format),
      metrics: post.metrics as PostMetrics,
    });
    await storage.writeObject(key, image, 'image/jpeg');
    written += 1;
  }
  console.log(`[seed] ${written} synthetic screenshots written to storage`);

  /* Links. Only hashes are stored; the raw tokens are printed once, here. */
  const magicLinks = creators.slice(0, 26).map((c, i) => {
    const token = randomBytes(32).toString('base64url');
    const opened = i < 15;
    return {
      raw: token,
      doc: {
        tokenHash: sha256(token),
        creatorId: c._id,
        campaignId: i < 18 ? campaignA : campaignB,
        issuedAt: daysAgo(47),
        // Already expired, matching the 15-minute policy. Seeded links are
        // history, not working credentials: run `npm run mint` for a live one.
        expiresAt: new Date(daysAgo(47).getTime() + 15 * 60_000),
        usedAt: opened ? daysAgo(46) : null,
        firstOpenedAt: opened ? daysAgo(46) : null,
        lastOpenedAt: opened ? daysAgo(int(3, 40)) : null,
        openCount: opened ? int(1, 9) : 0,
        consentCapturedAt: i < 12 ? daysAgo(46) : null,
        firstSubmissionAt: i < 9 ? daysAgo(int(5, 30)) : null,
        revokedAt: null,
        issuedByOperatorId: operatorId,
      },
    };
  });
  await MagicLinkModel.insertMany(magicLinks.map((m) => m.doc));


  /* ------------------------------------------------- orders and commission */

  /**
   * Commerce data, so the attribution and money surfaces have something real
   * to render.
   *
   * Deliberately imperfect. A seed where every order matches a creator makes
   * the unattributed view look like dead code and hides the number the brand
   * will actually ask about first — how much of their revenue the programme
   * can account for. Roughly a third of these orders match nobody, a few carry
   * the brand's own sitewide code, and two come back as refunds.
   */
  /**
   * Re-read rather than reusing the array above: insertMany does not write the
   * generated _id back onto the plain objects it was handed, and every
   * tracking asset needs the join's id.
   */
  const reportedJoins = await CampaignCreatorModel.find({
    campaignId: campaignA,
    status: { $in: ['reported', 'paid'] },
  }).lean();

  const assets: Record<string, unknown>[] = [];
  const codeByJoin = new Map<string, string>();

  for (const join of reportedJoins.slice(0, 8)) {
    const creator = creators.find((c) => String(c._id) === String(join.creatorId));
    const stub = normaliseStub(String(creator?.displayName ?? 'creator').split(' ')[0] ?? 'creator');
    const code = `${stub.slice(0, 6)}10`;
    codeByJoin.set(String(join._id), code);
    assets.push({
      campaignCreatorId: join._id,
      campaignId: campaignA,
      creatorId: join.creatorId,
      brandId: brandA,
      type: 'discount_code',
      value: code,
      matchKey: normaliseTypedCode(code),
      issuedAt: daysAgo(50),
      activeFrom: daysAgo(50),
      activeUntil: null,
      status: 'active',
      // A spread of rates, because a single rate across a roster hides every
      // rounding question the ledger exists to answer.
      commissionRateBps: pick([800, 1000, 1250, 1500]),
      commissionRateBasis: pick(['order_subtotal', 'order_total'] as const),
      issuedByOperatorId: operatorId,
    });
  }
  await TrackingAssetModel.insertMany(assets);
  console.log(`[seed] ${assets.length} discount codes`);

  const ingestBatch = await IngestBatchModel.create({
    brandId: brandA,
    source: 'manual_csv',
    status: 'committed',
    uploadedByOperatorId: operatorId,
    filename: 'kelp-orders-august.csv',
    rowsParsed: 0,
    committedAt: daysAgo(2),
    currencies: ['GBP'],
  });

  const issuedCodes = [...codeByJoin.values()];
  const orders: Record<string, unknown>[] = [];

  for (let i = 0; i < 90; i += 1) {
    const roll = rng();
    // A third carry nobody's code; a few carry the brand's own sale code,
    // which is not one of ours and must read as unattributed with a reason.
    const code =
      roll < 0.58 ? pick(issuedCodes) : roll < 0.66 ? 'AUTUMN15' : null;

    const subtotal = int(1_800, 14_500);
    const shipping = chance(0.6) ? 0 : 399;
    const refunded = chance(0.06);
    const partial = refunded && chance(0.4);

    orders.push({
      brandId: brandA,
      externalOrderId: `KC-${11_400 + i}`,
      source: 'manual_csv',
      orderedAt: daysAgo(int(2, 40)),
      total: { amountMinor: subtotal + shipping, currency: 'GBP' },
      subtotal: { amountMinor: subtotal, currency: 'GBP' },
      currency: 'GBP',
      discountCodeUsed: code,
      discountCodeKey: code ? normaliseTypedCode(code) : null,
      attributionRef: null,
      customerType: chance(0.62) ? 'new' : 'returning',
      status: refunded ? (partial ? 'partially_refunded' : 'refunded') : 'confirmed',
      refundedAmount: refunded
        ? { amountMinor: partial ? Math.floor(subtotal / 2) : subtotal + shipping, currency: 'GBP' }
        : null,
      refundedAt: refunded ? daysAgo(int(1, 3)) : null,
      ingestBatchId: ingestBatch._id,
      ingestHistory: [{ batchId: ingestBatch._id, at: daysAgo(2) }],
      // A realistic export row, customer details included — which is exactly
      // what must never reach a creator-facing response.
      rawRow: {
        'Order name': `KC-${11_400 + i}`,
        'Customer name': 'Seeded Customer',
        'Customer email': `customer${i}@example.invalid`,
        'Discount code': code ?? '',
      },
    });
  }
  await OrderModel.insertMany(orders);
  await IngestBatchModel.updateOne(
    { _id: ingestBatch._id },
    { $set: { rowsParsed: orders.length, rowsInserted: orders.length } },
  );
  console.log(`[seed] ${orders.length} orders`);

  const attribution = await runAttribution({ brandId: brandA });
  console.log(
    `[seed] attribution: ${attribution.attributed} attributed, ${attribution.unattributed} not ` +
      `(${Object.entries(attribution.byReason).map(([k, n]) => `${k} ${n}`).join(', ')})`,
  );

  const ledger = await postCommission({ brandId: brandA, createdBy: 'seed' });
  console.log(
    `[seed] ledger: ${ledger.accrualsCreated} accruals, ${ledger.reversalsCreated} reversals`,
  );

  /**
   * A couple of payments the brand says it made. Anton records the claim; it
   * never moves the money.
   */
  const paidJoins = reportedJoins.filter((j) => String(j.status) === 'paid').slice(0, 2);
  for (const join of paidJoins) {
    const owed = await CommissionEntryModel.aggregate<{ n: number }>([
      { $match: { creatorId: join.creatorId, campaignId: campaignA } },
      { $group: { _id: null, n: { $sum: '$amount.amountMinor' } } },
    ]);
    const total = owed[0]?.n ?? 0;
    if (total <= 0) continue;
    await PaymentRecordModel.create({
      creatorId: join.creatorId,
      campaignId: campaignA,
      brandId: brandA,
      // Part-paid on purpose, so "still owed" is a live number on the page.
      amount: { amountMinor: Math.floor(total * 0.6), currency: 'GBP' },
      paidAt: daysAgo(3),
      method: 'bank transfer',
      reference: 'KC-AUG-01',
      recordedByOperatorId: operatorId,
      recordedAt: daysAgo(3),
    });
  }

  const shareToken = randomBytes(32).toString('base64url');
  await ShareLinkModel.create({
    tokenHash: sha256(shareToken),
    campaignId: campaignA,
    label: 'Kelp & Co — launch report',
    issuedAt: daysAgo(5),
    expiresAt: daysAgo(-60),
    revokedAt: null,
    viewCount: 7,
    lastViewedAt: daysAgo(1),
    issuedByOperatorId: operatorId,
  });

  /* Summary */
  const byStatus = await PostModel.aggregate<{ _id: string; n: number }>([
    { $group: { _id: '$extraction.status', n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);

  console.log('\n[seed] extraction status distribution');
  for (const row of byStatus) console.log(`  ${String(row._id).padEnd(15)} ${row.n}`);

  console.log(
    '\n[seed] seeded magic links are already expired, matching the 15-minute policy.',
  );
  console.log('       run `npm run mint --workspace @anton/server` for a live one.');
  console.log(`\n[seed] brand share link\n  http://localhost:5210/r/${shareToken}\n`);

  console.log('\n[seed] operator sign-in (development only)');
  console.log('  email     ops@anton.example');
  console.log(`  password  ${DEV_PASSWORD}`);
  console.log('  2FA       add this to your authenticator app:');
  console.log(`            ${totpUri('ops@anton.example', DEV_TOTP_SECRET)}`);
  console.log(`  recovery  ${recovery.plain.join('  ')}`);

  await disconnectDb();
  console.log('\n[seed] done');
}

const reset = process.argv.includes('--reset');
seed(reset).catch(async (err: unknown) => {
  console.error('[seed] failed:', err);
  await disconnectDb().catch(() => undefined);
  process.exitCode = 1;
});
