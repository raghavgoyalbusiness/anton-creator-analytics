import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Server } from 'node:http';
import * as OTPAuth from 'otpauth';
import { createApp } from '../app.js';
import { closeTestServer, listenForTests } from '../testing/server.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import {
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  OperatorModel,
  PostModel,
  SessionModel,
  ShareLinkModel,
} from '../db/models/index.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { getStorage } from '../storage/index.js';
import { peekEmailCode } from './share.js';

let app: Server;
let operatorId: Types.ObjectId;
let campaignId: Types.ObjectId;
let creatorId: Types.ObjectId;

const PASSWORD = 'share-test-password';
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
    .send({ email: 'share@anton.example', password: PASSWORD, totpCode: code() });
  expect(res.status).toBe(200);
  return agent;
}

async function makeShareLink(
  overrides: Record<string, unknown> = {},
): Promise<{ url: string; token: string; id: string }> {
  const agent = await signedIn();
  const res = await agent.post('/api/operator/share-links').send({
    campaignId: campaignId.toString(),
    label: 'Test report',
    expiresInDays: 30,
    ...overrides,
  });
  expect(res.status).toBe(201);
  const token = new URL(res.body.url).pathname.split('/').pop() ?? '';
  return { url: res.body.url, token, id: res.body.id };
}

beforeAll(async () => {
  await connectDb();
  app = await listenForTests(createApp());
});
afterAll(async () => {
  await closeTestServer(app);
  await disconnectDb();
});

beforeEach(async () => {
  await Promise.all([
    OperatorModel.deleteMany({}),
    BrandModel.deleteMany({}),
    CreatorModel.deleteMany({}),
    CampaignModel.deleteMany({}),
    CampaignCreatorModel.deleteMany({}),
    PostModel.deleteMany({}),
    ShareLinkModel.deleteMany({}),
    SessionModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'share@anton.example',
    displayName: 'Share Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  const brandId = new Types.ObjectId();
  await BrandModel.create({ _id: brandId, name: 'Test Brand', defaultCurrency: 'GBP' });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId,
    name: 'Share Campaign',
    objective: 'prove cost efficiency',
    status: 'live',
    platforms: ['instagram'],
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-09-30T00:00:00Z'),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'flat_fee',
    currency: 'GBP',
    budgetTotal: { amountMinor: 200_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 5_000, currency: 'GBP' },
    megaBenchmark: {
      label: '1.4M creator',
      quotedFee: { amountMinor: 1_800_000, currency: 'GBP' },
      quotedReach: 620_000,
      sourceNote: 'Agency quote by email.',
      enteredAt: new Date(),
      enteredByOperatorId: operatorId,
    },
  });

  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Share Creator',
    handles: [{ platform: 'instagram', handle: 'share.creator' }],
    followerSnapshots: [
      { platform: 'instagram', count: 10_000, capturedAt: new Date('2026-06-01T00:00:00Z'), source: 'manual' },
    ],
    nicheTags: ['skincare'],
    status: 'active',
  });

  await CampaignCreatorModel.create({
    campaignId,
    creatorId,
    status: 'reported',
    agreedRate: { amountMinor: 5_000, currency: 'GBP' },
  });

  const key = `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`;
  await getStorage().writeObject(key, Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg');

  // One verified post that should appear, one needs_review that must not.
  await PostModel.create({
    creatorId,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: new Date('2026-08-15T09:00:00Z'),
    hookText: 'Three weeks in and here is the verdict',
    creativeAngleTags: ['honest-review'],
    metrics: { reach: 12_000, impressions: 14_000, likes: 600, comments: 40, shares: 20, saves: 80 },
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: key,
      sourceImageSha256: 'a'.repeat(64),
      extractedAt: new Date(),
      model: 'stub',
      promptVersion: 'extract-v1',
      rawResponse: '{}',
      parseOk: true,
      status: 'verified',
      plausibility: { passed: true, violations: [], skipped: [] },
      fieldConfidence: {},
    },
    verifiedByOperatorId: operatorId,
    verifiedAt: new Date(),
    submittedAt: new Date(),
  });

  await PostModel.create({
    creatorId,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: new Date('2026-08-16T09:00:00Z'),
    metrics: { reach: 999_999, likes: 50_000 },
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`,
      sourceImageSha256: 'b'.repeat(64),
      extractedAt: new Date(),
      model: 'stub',
      promptVersion: 'extract-v1',
      rawResponse: '{}',
      parseOk: true,
      status: 'needs_review',
      plausibility: { passed: false, violations: [], skipped: [] },
      fieldConfidence: {},
    },
    submittedAt: new Date(),
  });
});

/* ------------------------------------------------------------ link access */

describe('share link access', () => {
  it('refuses an unknown token', async () => {
    const res = await request(app).get('/api/report/' + 'x'.repeat(43));
    expect(res.status).toBe(404);
  });

  it('refuses a malformed token without a database hit', async () => {
    const res = await request(app).get('/api/report/short');
    expect(res.status).toBe(404);
  });

  it('opens a valid link', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.campaign.name).toBe('Share Campaign');
  });

  it('refuses an expired link', async () => {
    const { token } = await makeShareLink();
    await ShareLinkModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_expired');
  });

  it('refuses a revoked link immediately', async () => {
    const { token, id } = await makeShareLink();
    const agent = await signedIn();
    await agent.post(`/api/operator/share-links/${id}/revoke`).send({});

    const res = await request(app).get(`/api/report/${token}`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_revoked');
  });

  it('always carries an expiry — there is no never-expires option', async () => {
    await makeShareLink();
    const link = await ShareLinkModel.findOne({}).lean();
    expect(link?.expiresAt).toBeInstanceOf(Date);
    expect(link!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('sets noindex headers on the report', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.headers['x-robots-tag']).toContain('noindex');
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('logs each view with a hashed IP, never a raw one', async () => {
    const { token } = await makeShareLink();
    await request(app).get(`/api/report/${token}`);
    await request(app).get(`/api/report/${token}`);

    const link = await ShareLinkModel.findOne({}).lean();
    expect(link?.viewCount).toBe(2);
    expect(link?.views).toHaveLength(2);
    expect(link?.views[0]?.ipHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

/* -------------------------------------------------------------- toggles */

describe('display toggles', () => {
  it('hides creator compensation by default', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.creators[0].agreedRate).toBeNull();
    expect(JSON.stringify(res.body.creators)).not.toContain('5000');
  });

  it('shows compensation when the link says so', async () => {
    const { token, id } = await makeShareLink({ showCompensation: true });
    // Compensation forces the email gate on, so verify first.
    await request(app).post(`/api/report/${token}/request-code`).send({ email: 'brand@x.com' });
    const otp = peekEmailCode(id, 'brand@x.com');
    await request(app).post(`/api/report/${token}/verify-code`).send({ email: 'brand@x.com', code: otp });

    const res = await request(app).get(`/api/report/${token}?email=brand@x.com`);
    expect(res.body.creators[0].agreedRate).toMatchObject({ amountMinor: 5_000 });
  });

  it('forces the email gate on whenever compensation is shown', async () => {
    await makeShareLink({ showCompensation: true, requireEmailGate: false });
    const link = await ShareLinkModel.findOne({}).lean();
    // Rates are the most sensitive thing in the report; an unguessable URL is
    // not enough on its own to carry them.
    expect(link?.requireEmailGate).toBe(true);
  });

  it('shows handles by default', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.creators[0].handle).toBe('share.creator');
    expect(res.body.creators[0].displayName).toBe('Share Creator');
  });

  it('anonymises to niche and band when handles are switched off', async () => {
    const { token } = await makeShareLink({ showCreatorHandles: false });
    const res = await request(app).get(`/api/report/${token}`);
    const row = res.body.creators[0];
    expect(row.handle).toBeNull();
    expect(row.displayName).toBe('Creator');
    expect(row.followers).toBeNull();
    // Still useful to the brand: niche and size band survive.
    expect(row.nicheTags).toContain('skincare');
    expect(row.followerBand).toBe('micro_small');
    expect(JSON.stringify(res.body)).not.toContain('share.creator');
  });
});

/* ------------------------------------------------------------ email gate */

describe('email gate', () => {
  it('reveals nothing before verification', async () => {
    const { token } = await makeShareLink({ requireEmailGate: true });
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.gated).toBe(true);
    // Not even the campaign name leaks.
    expect(JSON.stringify(res.body)).not.toContain('Share Campaign');
  });

  it('opens once a code is verified', async () => {
    const { token, id } = await makeShareLink({ requireEmailGate: true });
    await request(app).post(`/api/report/${token}/request-code`).send({ email: 'brand@x.com' });
    const otp = peekEmailCode(id, 'brand@x.com');
    expect(otp).toMatch(/^\d{6}$/);

    const verify = await request(app)
      .post(`/api/report/${token}/verify-code`)
      .send({ email: 'brand@x.com', code: otp });
    expect(verify.status).toBe(200);

    const res = await request(app).get(`/api/report/${token}?email=brand@x.com`);
    expect(res.body.gated).toBe(false);
    expect(res.body.campaign.name).toBe('Share Campaign');
  });

  it('rejects a wrong code', async () => {
    const { token } = await makeShareLink({ requireEmailGate: true });
    await request(app).post(`/api/report/${token}/request-code`).send({ email: 'brand@x.com' });
    const res = await request(app)
      .post(`/api/report/${token}/verify-code`)
      .send({ email: 'brand@x.com', code: '000000' });
    expect(res.status).toBe(401);
  });

  it('a code is single-use', async () => {
    const { token, id } = await makeShareLink({ requireEmailGate: true });
    await request(app).post(`/api/report/${token}/request-code`).send({ email: 'brand@x.com' });
    const otp = peekEmailCode(id, 'brand@x.com');

    await request(app).post(`/api/report/${token}/verify-code`).send({ email: 'brand@x.com', code: otp });
    const again = await request(app)
      .post(`/api/report/${token}/verify-code`)
      .send({ email: 'brand@x.com', code: otp });
    expect(again.status).toBe(401);
  });

  it('does not reveal whether an address was expected', async () => {
    const { token } = await makeShareLink({ requireEmailGate: true });
    const res = await request(app)
      .post(`/api/report/${token}/request-code`)
      .send({ email: 'nobody@nowhere.example' });
    expect(res.status).toBe(201);
    expect(res.body.message).toMatch(/if that address/i);
  });

  it('records which address opened the report', async () => {
    const { token, id } = await makeShareLink({ requireEmailGate: true });
    await request(app).post(`/api/report/${token}/request-code`).send({ email: 'brand@x.com' });
    const otp = peekEmailCode(id, 'brand@x.com');
    await request(app).post(`/api/report/${token}/verify-code`).send({ email: 'brand@x.com', code: otp });
    await request(app).get(`/api/report/${token}?email=brand@x.com`);

    const link = await ShareLinkModel.findOne({}).lean();
    expect(link?.views.at(-1)?.viewerEmail).toBe('brand@x.com');
  });
});

/* ----------------------------------------------------------- the numbers */

describe('report contents', () => {
  it('includes only signed-off posts and says what it excluded', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);

    expect(res.body.summary.postsLive).toBe(1);
    expect(res.body.summary.totalReach.value).toBe(12_000);
    // The needs_review post's 999,999 reach must not be in there.
    expect(res.body.summary.totalReach.value).not.toBe(1_011_999);
    expect(res.body.summary.coverage.excludedNotVerified).toBe(1);
    expect(res.body.methodology.exclusions).toMatch(/still being checked/);
  });

  it('labels screenshot-sourced numbers as creator-reported, not verified', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    const post = res.body.creators[0].posts[0];
    expect(post.provenance.label).toBe('Creator-reported, source image attached');
    expect(post.provenance.isPlatformVerified).toBe(false);
    expect(res.body.methodology.verificationLimit).toMatch(/not platform-verified/);
  });

  it('links every post to its source screenshot', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    const post = res.body.creators[0].posts[0];
    expect(post.sourceScreenshotUrl).toBeTruthy();
    expect(post.sourceImageSha256).toMatch(/^[a-f0-9]{64}$/);

    const url = new URL(post.sourceScreenshotUrl);
    const img = await request(app).get(`${url.pathname}${url.search}`);
    expect(img.status).toBe(200);
  });

  it('marks the benchmark as operator-supplied and carries its source note', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.comparison.sourceNote).toBe('Agency quote by email.');
    expect(res.body.comparison.benchmarkCostPerThousandReach).toBeCloseTo(1_800_000 / 620, 1);
  });

  it('states plainly that there is no conversion data rather than showing zero', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.conversions.reportedRedemptions).toBeNull();
    expect(res.body.conversions.statement).toMatch(/No conversion data/);
    expect(res.body.conversions.statement).toMatch(/Anton measures reach and engagement/);
  });

  it('bases spend on agreed rates, not the campaign budget', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    // Budget is 200000 minor; one creator at 5000 took part.
    expect(res.body.summary.spend.amountMinor).toBe(5_000);
    expect(res.body.methodology.spend).toMatch(/not the campaign budget/);
  });

  it('groups by creative angle, format and niche', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.breakdowns.byCreativeAngle[0].key).toBe('honest-review');
    expect(res.body.breakdowns.byFormat[0].key).toBe('reel');
    expect(res.body.breakdowns.byNiche[0].key).toBe('skincare');
  });

  it('ranks hooks by engagement rate', async () => {
    const { token } = await makeShareLink();
    const res = await request(app).get(`/api/report/${token}`);
    expect(res.body.topHooks[0].hookText).toMatch(/Three weeks in/);
  });
});
