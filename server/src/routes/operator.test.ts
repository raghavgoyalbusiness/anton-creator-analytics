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
  AuditLogModel,
  CampaignModel,
  CreatorModel,
  OperatorModel,
  PostModel,
  SessionModel,
} from '../db/models/index.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { getStorage } from '../storage/index.js';

let app: Server;
let operatorId: Types.ObjectId;
let creatorId: Types.ObjectId;
let campaignId: Types.ObjectId;
let postId: Types.ObjectId;

const PASSWORD = 'correct-horse-battery-staple';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function currentCode(): string {
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
    .send({ email: 'op@anton.example', password: PASSWORD, totpCode: currentCode() });
  expect(res.status).toBe(200);
  return agent;
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
    CreatorModel.deleteMany({}),
    CampaignModel.deleteMany({}),
    PostModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'op@anton.example',
    displayName: 'Test Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Queue Creator',
    handles: [{ platform: 'instagram', handle: 'queue.creator' }],
    followerSnapshots: [
      { platform: 'instagram', count: 12_000, capturedAt: new Date('2026-06-01T00:00:00Z'), source: 'manual' },
    ],
    status: 'active',
  });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId: new Types.ObjectId(),
    name: 'Queue Campaign',
    status: 'live',
    platforms: ['instagram'],
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-09-30T00:00:00Z'),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'gifted',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });

  const key = `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`;
  await getStorage().writeObject(key, Buffer.from([0xff, 0xd8, 0xff, 0xdb]), 'image/jpeg');

  const post = await PostModel.create({
    creatorId,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: new Date('2026-08-15T09:00:00Z'),
    metrics: { reach: 8_000, impressions: 9_500, likes: 400, comments: 20, shares: 10, saves: 30 },
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: key,
      sourceImageSha256: 'a'.repeat(64),
      extractedAt: new Date(),
      model: 'stub-model',
      promptVersion: 'extract-v1',
      rawResponse: '{"platform":"instagram"}',
      parseOk: true,
      status: 'needs_review',
      routingReasons: ['saves confidence 0.61 is below the 0.85 threshold.'],
      fieldConfidence: { reach: 0.97, saves: 0.61 },
      plausibility: { passed: true, violations: [], skipped: [] },
    },
    trust: { submissionLagHours: 3, withinSubmissionWindow: true, exifPresent: false },
    submittedAt: new Date(),
  });
  postId = post._id;
});

/* ------------------------------------------------------------------ auth */

describe('operator authentication', () => {
  it('rejects a wrong password with a generic message', async () => {
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: 'wrong', totpCode: currentCode() });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('gives the same generic answer for an account that does not exist', async () => {
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'nobody@anton.example', password: PASSWORD, totpCode: currentCode() });
    expect(res.status).toBe(401);
    // Identical code and message: no account enumeration.
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('refuses a correct password with no TOTP code', async () => {
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: PASSWORD, totpCode: '' });
    expect(res.status).toBe(401);
  });

  it('refuses a correct password with a wrong TOTP code', async () => {
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: PASSWORD, totpCode: '000000' });
    expect(res.status).toBe(401);
  });

  it('accepts password plus a valid TOTP code and sets a strict cookie', async () => {
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: PASSWORD, totpCode: currentCode() });
    expect(res.status).toBe(200);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const cookie = cookies.find((c) => c.startsWith('anton_operator_session='));
    expect(cookie).toContain('HttpOnly');
    // Stricter than the creator cookie: an operator never arrives via a link.
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses an operator who has not completed TOTP enrolment', async () => {
    await OperatorModel.updateOne({ _id: operatorId }, { $set: { totpEnrolledAt: null } });
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: PASSWORD, totpCode: currentCode() });
    // No grace period: an un-enrolled account cannot sign in at all.
    expect(res.status).toBe(401);
  });

  it('locks the account after repeated failures', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/operator/auth/login')
        .send({ email: 'op@anton.example', password: 'wrong', totpCode: '000000' });
    }
    const res = await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: PASSWORD, totpCode: currentCode() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('account_locked');
  });

  it('audits both successful and failed sign-ins', async () => {
    await request(app)
      .post('/api/operator/auth/login')
      .send({ email: 'op@anton.example', password: 'wrong', totpCode: '000000' });
    await signedIn();

    const failed = await AuditLogModel.findOne({ action: 'operator.login.failed' }).lean();
    const ok = await AuditLogModel.findOne({ action: 'operator.login' }).lean();
    expect(failed).not.toBeNull();
    expect(ok).not.toBeNull();
    expect(ok?.ipHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never returns a password hash or TOTP secret', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/auth/me');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain(TOTP_SECRET);
  });

  it('rejects queue access with no session', async () => {
    const res = await request(app).get('/api/operator/queue');
    expect(res.status).toBe(401);
  });
});

/* ----------------------------------------------------------------- queue */

describe('verification queue', () => {
  it('returns needs_review posts with everything one screen needs', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/queue');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);

    const item = res.body.items[0];
    expect(item.creator.displayName).toBe('Queue Creator');
    // The follower count as at the post date, not today's.
    expect(item.creator.followersAtPost).toBe(12_000);
    expect(item.extraction.fieldConfidence.saves).toBe(0.61);
    expect(item.extraction.routingReasons.length).toBeGreaterThan(0);
    expect(item.screenshotUrl).toBeTruthy();
    expect(item.derived.engagementRate).toBeCloseTo(460 / 8000);
  });

  it('serves a short-lived screenshot URL that actually resolves', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/queue');
    const url = new URL(res.body.items[0].screenshotUrl);
    const img = await request(app).get(`${url.pathname}${url.search}`);
    expect(img.status).toBe(200);
  });

  it('exposes the raw model output behind its own endpoint', async () => {
    const agent = await signedIn();
    const res = await agent.get(`/api/operator/posts/${postId.toString()}/raw`);
    expect(res.status).toBe(200);
    expect(res.body.rawResponse).toBe('{"platform":"instagram"}');
  });

  it('rejects a malformed post id', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/posts/not-an-id/raw');
    expect(res.status).toBe(400);
  });
});

/* -------------------------------------------------------------- decisions */

describe('verify and reject', () => {
  const baseMetrics = {
    reach: 8_000,
    impressions: 9_500,
    likes: 400,
    comments: 20,
    shares: 10,
    saves: 30,
    profileVisits: null,
    linkClicks: null,
    videoViews: null,
    watchTimeSeconds: null,
    followsFromPost: null,
  };

  it('verifies without overrides when nothing changed', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: baseMetrics });
    expect(res.status).toBe(200);
    expect(res.body.overridesRecorded).toBe(0);

    const post = await PostModel.findById(postId).lean();
    expect(post?.extraction?.status).toBe('verified');
    expect(post?.verifiedByOperatorId?.toString()).toBe(operatorId.toString());
  });

  it('writes an append-only override record for every changed metric', async () => {
    const agent = await signedIn();
    const res = await agent.post(`/api/operator/posts/${postId.toString()}/decide`).send({
      decision: 'verify',
      metrics: { ...baseMetrics, saves: 87, likes: 402 },
      overrideReasons: { saves: 'Misread; the panel shows 87.' },
    });
    expect(res.body.overridesRecorded).toBe(2);

    const post = await PostModel.findById(postId).lean();
    const saves = post?.manualOverrides.find((o) => o.field === 'saves');
    expect(saves).toMatchObject({ from: 30, to: 87 });
    expect(saves?.by?.toString()).toBe(operatorId.toString());
    expect(saves?.reason).toBe('Misread; the panel shows 87.');
    expect(post?.metrics.saves).toBe(87);
  });

  it('appends rather than overwriting when a field is corrected twice', async () => {
    const agent = await signedIn();
    await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: { ...baseMetrics, saves: 87 } });
    await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: { ...baseMetrics, saves: 91 } });

    const post = await PostModel.findById(postId).lean();
    const saveOverrides = post?.manualOverrides.filter((o) => o.field === 'saves') ?? [];
    // Both corrections survive. A keyed Record would have lost the first.
    expect(saveOverrides).toHaveLength(2);
    // Asserted as a chain rather than by index: what matters is that the second
    // correction starts where the first ended, so the trail reads 30 -> 87 -> 91
    // rather than as two independent edits from the original value.
    const chain = saveOverrides.map((o) => [o.from, o.to]);
    expect(chain).toEqual([
      [30, 87],
      [87, 91],
    ]);
  });

  /**
   * The route guards its write with the metric values it read, so a second
   * operator whose read went stale matches nothing and is refused.
   *
   * The race itself cannot be staged from outside the process — anything this
   * test changes before the request is simply what the route then reads. So
   * this exercises the mechanism the guard depends on: that a filter pinned to
   * superseded values matches no document.
   */
  it('a write pinned to superseded metric values matches nothing', async () => {
    const before = await PostModel.findById(postId).lean();
    const pinned: Record<string, unknown> = { _id: postId };
    for (const [key, value] of Object.entries(before?.metrics ?? {})) {
      pinned[`metrics.${key}`] = value;
    }

    // Someone else lands a change first.
    await PostModel.updateOne({ _id: postId }, { $set: { 'metrics.saves': 55 } });

    const stale = await PostModel.updateOne(pinned, {
      $set: { 'metrics.saves': 91 },
      $push: { manualOverrides: { field: 'saves', from: 30, to: 91, by: operatorId, at: new Date(), reason: null } },
    });

    expect(stale.matchedCount).toBe(0);

    // Nothing was written: a corrupt chain is worse than a refused edit.
    const after = await PostModel.findById(postId).lean();
    expect(after?.manualOverrides).toHaveLength(0);
    expect(after?.metrics.saves).toBe(55);
  });

  it('a write pinned to current metric values succeeds', async () => {
    const before = await PostModel.findById(postId).lean();
    const pinned: Record<string, unknown> = { _id: postId };
    for (const [key, value] of Object.entries(before?.metrics ?? {})) {
      pinned[`metrics.${key}`] = value;
    }
    const fresh = await PostModel.updateOne(pinned, { $set: { 'metrics.saves': 91 } });
    expect(fresh.matchedCount).toBe(1);
  });

  it('records an override that clears a metric to null', async () => {
    const agent = await signedIn();
    await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: { ...baseMetrics, saves: null } });

    const post = await PostModel.findById(postId).lean();
    expect(post?.metrics.saves).toBeNull();
    expect(post?.manualOverrides.find((o) => o.field === 'saves')).toMatchObject({ from: 30, to: null });
  });

  it('refuses a rejection with no reason', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'reject', metrics: baseMetrics, rejectedReason: '   ' });
    expect(res.status).toBe(400);
  });

  it('rejects with a reason and names the operator', async () => {
    const agent = await signedIn();
    const res = await agent.post(`/api/operator/posts/${postId.toString()}/decide`).send({
      decision: 'reject',
      metrics: baseMetrics,
      rejectedReason: 'Screenshot is of a different post.',
    });
    expect(res.status).toBe(200);

    const post = await PostModel.findById(postId).lean();
    expect(post?.extraction?.status).toBe('rejected');
    expect(post?.rejectedReason).toBe('Screenshot is of a different post.');
    expect(post?.verifiedByOperatorId?.toString()).toBe(operatorId.toString());
  });

  it('refuses to decide a post that has not been extracted yet', async () => {
    await PostModel.updateOne({ _id: postId }, { $set: { 'extraction.status': 'pending' } });
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: baseMetrics });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('still_pending');
  });

  it('audits the decision with the field-level changes', async () => {
    const agent = await signedIn();
    await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: { ...baseMetrics, saves: 87 } });

    const audit = await AuditLogModel.findOne({ action: 'post.metric.overridden' }).lean();
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.detail)).toContain('saves');
  });

  it('refuses a metric value that is not a whole non-negative number', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/posts/${postId.toString()}/decide`)
      .send({ decision: 'verify', metrics: { ...baseMetrics, saves: -5 } });
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------ spot audit */

describe('spot audit', () => {
  it('records an outcome against the post', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/posts/${postId.toString()}/spot-audit`)
      .send({ outcome: 'passed', note: 'Screen shared, figures matched.' });
    expect(res.status).toBe(200);

    const post = await PostModel.findById(postId).lean();
    expect(post?.trust?.spotAuditOutcome).toBe('passed');
    expect(post?.trust?.spotAuditAt).not.toBeNull();
  });
});

/* -------------------------------------------------------------- dashboard */

describe('dashboard', () => {
  it('surfaces instruction-text detections as a headline number', async () => {
    await PostModel.updateOne(
      { _id: postId },
      { $set: { 'extraction.instructionTextDetected': true } },
    );
    const agent = await signedIn();
    const res = await agent.get('/api/operator/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.instructionTextDetected).toBe(1);
  });

  it('reports spend and outstanding spot audits', async () => {
    await PostModel.updateOne({ _id: postId }, { $set: { 'trust.flaggedForSpotAudit': true } });
    const agent = await signedIn();
    const res = await agent.get('/api/operator/dashboard');
    expect(res.body.spotAuditsOutstanding).toBe(1);
    expect(res.body.spend).toHaveProperty('todayMinor');
  });
});
