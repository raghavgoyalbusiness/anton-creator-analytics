import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Express } from 'express';
import * as OTPAuth from 'otpauth';
import { createApp } from '../app.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import {
  AuditLogModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  MagicLinkModel,
  OperatorModel,
  PostModel,
  SessionModel,
} from '../db/models/index.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Express;
let operatorId: Types.ObjectId;
let campaignId: Types.ObjectId;
const creatorIds: Types.ObjectId[] = [];

const PASSWORD = 'roster-test-password';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function code(): string {
  return new OTPAuth.TOTP({
    issuer: 'Anton',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(TOTP_SECRET),
  }).generate();
}

async function signedIn(): Promise<TestAgent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/operator/auth/login')
    .send({ email: 'roster@anton.example', password: PASSWORD, totpCode: code() });
  expect(res.status).toBe(200);
  return agent;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

beforeAll(async () => {
  await connectDb();
  app = createApp();
});
afterAll(async () => {
  await disconnectDb();
});

beforeEach(async () => {
  await Promise.all([
    OperatorModel.deleteMany({}),
    CreatorModel.deleteMany({}),
    CampaignModel.deleteMany({}),
    CampaignCreatorModel.deleteMany({}),
    PostModel.deleteMany({}),
    MagicLinkModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();
  creatorIds.length = 0;

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'roster@anton.example',
    displayName: 'Roster Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId: new Types.ObjectId(),
    name: 'Roster Campaign',
    status: 'live',
    platforms: ['instagram'],
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-09-30T00:00:00Z'),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'flat_fee',
    currency: 'GBP',
    budgetTotal: { amountMinor: 500_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 5_000, currency: 'GBP' },
  });

  // Three creators across different follower bands and niches.
  const specs = [
    { name: 'Nano Creator', handle: 'nano.one', followers: 3_000, niche: 'skincare' },
    { name: 'Micro Creator', handle: 'micro.two', followers: 18_000, niche: 'fitness' },
    { name: 'Larger Creator', handle: 'larger.three', followers: 45_000, niche: 'skincare' },
  ];

  for (const spec of specs) {
    const id = new Types.ObjectId();
    creatorIds.push(id);
    await CreatorModel.create({
      _id: id,
      displayName: spec.name,
      handles: [{ platform: 'instagram', handle: spec.handle }],
      followerSnapshots: [
        {
          platform: 'instagram',
          count: spec.followers,
          capturedAt: new Date('2026-06-01T00:00:00Z'),
          source: 'manual',
        },
      ],
      nicheTags: [spec.niche],
      status: 'active',
      consent: {
        grantedAt: new Date('2026-06-01T00:00:00Z'),
        scopeVersion: '2026-08-v1',
        documentSha256: 'a'.repeat(64),
        ipHash: 'b'.repeat(64),
        method: 'web_form',
        withdrawnAt: null,
      },
    });
  }
});

async function addPost(
  creatorId: Types.ObjectId,
  metrics: Record<string, number | null>,
  status = 'verified',
): Promise<void> {
  await PostModel.create({
    creatorId,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: new Date('2026-08-10T09:00:00Z'),
    metrics,
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`,
      sourceImageSha256: crypto.randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64),
      extractedAt: new Date(),
      model: 'stub',
      promptVersion: 'extract-v1',
      rawResponse: '{}',
      parseOk: true,
      status,
      plausibility: { passed: true, violations: [], skipped: [] },
      fieldConfidence: {},
    },
    verifiedByOperatorId: status === 'verified' ? operatorId : null,
    verifiedAt: status === 'verified' ? new Date() : null,
    submittedAt: new Date(),
  });
}

/* ----------------------------------------------------------------- roster */

describe('roster', () => {
  it('requires an operator session', async () => {
    const res = await request(app).get('/api/operator/roster');
    expect(res.status).toBe(401);
  });

  it('lists creators with follower band and consent state', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster');
    expect(res.status).toBe(200);
    expect(res.body.creators).toHaveLength(3);

    const nano = res.body.creators.find((c: { displayName: string }) => c.displayName === 'Nano Creator');
    expect(nano.followerBand).toBe('nano');
    expect(nano.hasConsent).toBe(true);
  });

  it('reports median engagement rate as null when there are no reportable posts', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster');
    // null, not zero: no measurement is not a measurement of zero.
    expect(res.body.creators.every((c: { medianEngagementRate: number | null }) => c.medianEngagementRate === null)).toBe(true);
  });

  it('uses the median so one viral post does not distort a creator', async () => {
    const target = creatorIds[0];
    if (!target) throw new Error('no creator');
    // Three ordinary posts at 5%, one outlier at 40%.
    await addPost(target, { reach: 1_000, likes: 50 });
    await addPost(target, { reach: 1_000, likes: 50 });
    await addPost(target, { reach: 1_000, likes: 50 });
    await addPost(target, { reach: 1_000, likes: 400 });

    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster');
    const row = res.body.creators.find((c: { id: string }) => c.id === target.toString());
    // A mean would be ~13.75%; the median holds at 5%.
    expect(row.medianEngagementRate).toBeCloseTo(0.05, 3);
  });

  it('excludes posts that have not been signed off from the median', async () => {
    const target = creatorIds[0];
    if (!target) throw new Error('no creator');
    await addPost(target, { reach: 1_000, likes: 50 }, 'verified');
    await addPost(target, { reach: 1_000, likes: 900 }, 'needs_review');

    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster');
    const row = res.body.creators.find((c: { id: string }) => c.id === target.toString());
    expect(row.reportablePosts).toBe(1);
    expect(row.medianEngagementRate).toBeCloseTo(0.05, 3);
  });

  it('filters by niche', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster?niche=skincare');
    expect(res.body.creators).toHaveLength(2);
  });

  it('filters by follower band', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster?band=nano');
    expect(res.body.creators).toHaveLength(1);
    expect(res.body.creators[0].displayName).toBe('Nano Creator');
  });

  it('searches by handle', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster?search=micro');
    expect(res.body.creators).toHaveLength(1);
  });

  it('treats a regex metacharacter in search as a literal', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster?search=' + encodeURIComponent('.*'));
    // Escaped, so it matches nothing rather than everything.
    expect(res.body.creators).toHaveLength(0);
  });

  it('sorts creators with no engagement rate last, not as zero', async () => {
    const target = creatorIds[1];
    if (!target) throw new Error('no creator');
    await addPost(target, { reach: 1_000, likes: 50 });

    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster?sort=engagement');
    expect(res.body.creators[0].id).toBe(target.toString());
    expect(res.body.creators[0].medianEngagementRate).toBeGreaterThan(0);
  });

  it('excludes removed creators by default', async () => {
    await CreatorModel.updateOne({ _id: creatorIds[0] }, { $set: { status: 'removed' } });
    const agent = await signedIn();
    const res = await agent.get('/api/operator/roster');
    expect(res.body.creators).toHaveLength(2);
  });
});

/* ---------------------------------------------------------- bulk invites */

describe('bulk invite', () => {
  it('mints one short-lived single-use link per creator', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/invites')
      .send({ creatorIds: creatorIds.map((i) => i.toString()), campaignId: campaignId.toString() });

    expect(res.status).toBe(201);
    expect(res.body.links).toHaveLength(3);
    expect(res.body.ttlMinutes).toBe(15);
    // The operational tension is stated in the response, not discovered later.
    expect(res.body.warning).toMatch(/expire in 15 minutes/);

    for (const link of res.body.links) {
      expect(link.url).toMatch(/\/c\/[A-Za-z0-9_-]{43}$/);
    }

    const stored = await MagicLinkModel.find({}).lean();
    expect(stored).toHaveLength(3);
    // Only hashes are persisted.
    for (const s of stored) expect(s.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('a minted link actually works, once', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/invites')
      .send({ creatorIds: [creatorIds[0]?.toString()], campaignId: null });

    const url = new URL(res.body.links[0].url);
    const token = url.pathname.split('/').pop() ?? '';

    const first = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(first.status).toBe(201);
    const second = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(second.status).toBe(410);
  });

  it('skips removed creators', async () => {
    await CreatorModel.updateOne({ _id: creatorIds[0] }, { $set: { status: 'removed' } });
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/invites')
      .send({ creatorIds: creatorIds.map((i) => i.toString()), campaignId: null });
    expect(res.body.links).toHaveLength(2);
  });

  it('audits the issue', async () => {
    const agent = await signedIn();
    await agent
      .post('/api/operator/invites')
      .send({ creatorIds: [creatorIds[0]?.toString()], campaignId: null });
    const audit = await AuditLogModel.findOne({ action: 'magic_links.issued' }).lean();
    expect(audit).not.toBeNull();
  });

  it('revokes every unspent link and session for a creator', async () => {
    const agent = await signedIn();
    const issued = await agent
      .post('/api/operator/invites')
      .send({ creatorIds: [creatorIds[0]?.toString()], campaignId: null });
    const token = (new URL(issued.body.links[0].url).pathname.split('/').pop() ?? '');

    const res = await agent.post(`/api/operator/creators/${creatorIds[0]?.toString()}/revoke-links`).send({});
    expect(res.status).toBe(200);
    expect(res.body.linksRevoked).toBeGreaterThanOrEqual(1);

    const exchange = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(exchange.status).toBe(410);
  });
});

/* ------------------------------------------------------------ nudge list */

describe('nudge list', () => {
  it('separates accepted-not-posted from posted-not-submitted', async () => {
    const [a, b, c] = creatorIds;
    if (!a || !b || !c) throw new Error('creators missing');
    const old = new Date(Date.now() - 10 * DAY);

    await CampaignCreatorModel.create({
      campaignId, creatorId: a, status: 'accepted', invitedAt: old, respondedAt: old,
    });
    await CampaignCreatorModel.create({
      campaignId, creatorId: b, status: 'posted', invitedAt: old, firstPostedAt: old,
    });
    await CampaignCreatorModel.create({
      campaignId, creatorId: c, status: 'invited', invitedAt: old,
    });

    const agent = await signedIn();
    const res = await agent.get('/api/operator/nudges');

    expect(res.body.acceptedNotPosted).toHaveLength(1);
    expect(res.body.postedNotSubmitted).toHaveLength(1);
    expect(res.body.invitedNoReply).toHaveLength(1);
    expect(res.body.total).toBe(3);
    // Different reasons, because they need different messages.
    expect(res.body.acceptedNotPosted[0].reason).not.toBe(res.body.postedNotSubmitted[0].reason);
  });

  it('respects the threshold', async () => {
    const a = creatorIds[0];
    if (!a) throw new Error('no creator');
    await CampaignCreatorModel.create({
      campaignId,
      creatorId: a,
      status: 'accepted',
      invitedAt: new Date(Date.now() - 2 * HOUR),
      respondedAt: new Date(Date.now() - 2 * HOUR),
    });

    const agent = await signedIn();
    const recent = await agent.get('/api/operator/nudges?thresholdHours=120');
    expect(recent.body.acceptedNotPosted).toHaveLength(0);

    const aggressive = await agent.get('/api/operator/nudges?thresholdHours=1');
    expect(aggressive.body.acceptedNotPosted).toHaveLength(1);
  });

  it('drops someone from posted-not-submitted once they submit', async () => {
    const b = creatorIds[1];
    if (!b) throw new Error('no creator');
    const old = new Date(Date.now() - 10 * DAY);
    await CampaignCreatorModel.create({
      campaignId, creatorId: b, status: 'posted', invitedAt: old, firstPostedAt: old,
    });

    const agent = await signedIn();
    expect((await agent.get('/api/operator/nudges')).body.postedNotSubmitted).toHaveLength(1);

    await addPost(b, { reach: 500, likes: 20 }, 'needs_review');
    expect((await agent.get('/api/operator/nudges')).body.postedNotSubmitted).toHaveLength(0);
  });

  it('never chases someone who declined', async () => {
    const a = creatorIds[0];
    if (!a) throw new Error('no creator');
    await CampaignCreatorModel.create({
      campaignId,
      creatorId: a,
      status: 'declined',
      invitedAt: new Date(Date.now() - 30 * DAY),
    });
    const agent = await signedIn();
    const res = await agent.get('/api/operator/nudges');
    expect(res.body.total).toBe(0);
  });
});

/* -------------------------------------------------------------- benchmark */

describe('mega-influencer benchmark', () => {
  it('requires a source note', async () => {
    const agent = await signedIn();
    const res = await agent.put(`/api/operator/campaigns/${campaignId.toString()}/benchmark`).send({
      label: '1.4M beauty creator',
      quotedFeeMinor: 1_800_000,
      quotedReach: 620_000,
      sourceNote: '',
    });
    expect(res.status).toBe(400);
  });

  it('stores the figure with its provenance and who entered it', async () => {
    const agent = await signedIn();
    const res = await agent.put(`/api/operator/campaigns/${campaignId.toString()}/benchmark`).send({
      label: '1.4M beauty creator',
      quotedFeeMinor: 1_800_000,
      quotedReach: 620_000,
      sourceNote: 'Agency quote by email, 2026-07-14.',
    });
    expect(res.status).toBe(200);

    const campaign = await CampaignModel.findById(campaignId).lean();
    expect(campaign?.megaBenchmark?.sourceNote).toBe('Agency quote by email, 2026-07-14.');
    expect(campaign?.megaBenchmark?.enteredByOperatorId?.toString()).toBe(operatorId.toString());
    // Currency inherited from the campaign, never guessed.
    expect(campaign?.megaBenchmark?.quotedFee.currency).toBe('GBP');
  });
});

/* ------------------------------------------------------------- one creator */

describe('creator detail', () => {
  it('audits that an operator read a creator record', async () => {
    const agent = await signedIn();
    await agent.get(`/api/operator/creators/${creatorIds[0]?.toString()}`);
    const audit = await AuditLogModel.findOne({ action: 'operator.creator.viewed' }).lean();
    expect(audit).not.toBeNull();
    expect(audit?.subjectId?.toString()).toBe(creatorIds[0]?.toString());
  });

  it('appends a follower snapshot without overwriting history', async () => {
    const agent = await signedIn();
    await agent
      .post(`/api/operator/creators/${creatorIds[0]?.toString()}/followers`)
      .send({ platform: 'instagram', count: 4_200 });

    const creator = await CreatorModel.findById(creatorIds[0]).lean();
    expect(creator?.followerSnapshots).toHaveLength(2);
    expect(creator?.followerSnapshots[0]?.count).toBe(3_000);
  });
});
