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
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  MagicLinkModel,
  OperatorModel,
  PostModel,
  SessionModel,
} from '../db/models/index.js';
import { ContentLicenseModel } from '../db/models/ContentLicense.js';
import { hashPassword } from '../lib/operator-session.js';
import { mintToken } from '../lib/tokens.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { loadConsentDocument } from '../config/consent.js';

let app: Server;
let operatorId: Types.ObjectId;
let brandId: Types.ObjectId;
let campaignId: Types.ObjectId;
let creatorId: Types.ObjectId;
let otherCreatorId: Types.ObjectId;
let joinId: Types.ObjectId;
let postId: Types.ObjectId;
let otherPostId: Types.ObjectId;

const PASSWORD = 'licensing-test-password';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day, 12, 0, 0));
const soon = (days: number): Date => new Date(Date.now() + days * 86_400_000);

function totp(): string {
  return new OTPAuth.TOTP({
    issuer: 'Anton',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(TOTP_SECRET),
  }).generate();
}

async function operator(): Promise<TestAgent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/operator/auth/login')
    .send({ email: 'rights@anton.example', password: PASSWORD, totpCode: totp() });
  expect(res.status).toBe(200);
  return agent;
}

async function creatorAgent(who: Types.ObjectId = creatorId): Promise<TestAgent> {
  const agent = request.agent(app);
  const minted = mintToken();
  await MagicLinkModel.create({
    tokenHash: minted.hash,
    creatorId: who,
    campaignId,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    issuedByOperatorId: operatorId,
  });
  const res = await agent.post('/api/creator/session/exchange').send({ token: minted.raw });
  expect(res.status).toBe(201);
  return agent;
}

const REQUEST_BODY = {
  scope: 'named_posts' as const,
  permittedUses: ['organic_reshare', 'paid_amplification'],
  territory: ['GB'],
  startsAt: AUG(1).toISOString(),
  endsAt: null,
  modificationPermitted: true,
  whitelistingPermitted: false,
  nameAndLikenessPermitted: false,
};

async function requestLicence(
  agent: TestAgent,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; termsSha256: string }> {
  const res = await agent.post('/api/operator/licences/request').send({
    campaignCreatorId: joinId.toString(),
    postIds: [postId.toString()],
    ...REQUEST_BODY,
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function makePost(creator: Types.ObjectId, url: string): Promise<Types.ObjectId> {
  const doc = await PostModel.create({
    creatorId: creator,
    campaignId,
    platform: 'instagram',
    format: 'reel',
    postedAt: AUG(4),
    publicUrl: url,
    metricSource: 'screenshot',
    extraction: {
      sourceImageKey: `k/${url}`,
      sourceImageSha256: 'a'.repeat(64),
      extractedAt: AUG(4),
      model: 'stub',
      promptVersion: 'extract-v1',
      rawResponse: '{}',
      parseOk: true,
      status: 'verified',
      plausibility: { passed: true, violations: [], skipped: [] },
      fieldConfidence: {},
    },
    verifiedByOperatorId: operatorId,
    verifiedAt: AUG(5),
    submittedAt: AUG(4),
  });
  return doc._id;
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
    ContentLicenseModel.deleteMany({}),
    SessionModel.deleteMany({}),
    MagicLinkModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'rights@anton.example',
    displayName: 'Rights Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  brandId = new Types.ObjectId();
  await BrandModel.create({ _id: brandId, name: 'Kelp & Co', defaultCurrency: 'GBP' });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId,
    name: 'Barrier Serum Launch',
    status: 'live',
    platforms: ['instagram'],
    startDate: AUG(1),
    endDate: new Date(Date.UTC(2027, 11, 31)),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });

  const consent = await loadConsentDocument();
  const consentBlock = {
    grantedAt: AUG(1),
    scopeVersion: consent.version,
    documentSha256: consent.sha256,
    method: 'web_form' as const,
    ipHash: 'a'.repeat(64),
    withdrawnAt: null,
  };

  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Amara Bell',
    handles: [{ platform: 'instagram', handle: 'amara.bell' }],
    status: 'active',
    consent: consentBlock,
  });
  otherCreatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: otherCreatorId,
    displayName: 'Tom Yilmaz',
    handles: [{ platform: 'instagram', handle: 'tom.yilmaz' }],
    status: 'active',
    consent: consentBlock,
  });

  joinId = (await CampaignCreatorModel.create({ campaignId, creatorId, status: 'reported' }))._id;
  await CampaignCreatorModel.create({ campaignId, creatorId: otherCreatorId, status: 'reported' });

  postId = await makePost(creatorId, 'https://instagram.com/p/amara1');
  otherPostId = await makePost(otherCreatorId, 'https://instagram.com/p/tom1');
});

/* ------------------------------------------------------------ the asymmetry */

describe('only the creator can grant', () => {
  it('an operator request creates a licence that permits nothing', async () => {
    const agent = await operator();
    const { id } = await requestLicence(agent);

    const doc = await ContentLicenseModel.findById(id).lean();
    expect(doc?.grantedAt).toBeNull();
    expect(doc?.requestedByOperatorId?.toString()).toBe(operatorId.toString());
    expect(doc?.termsSha256).toMatch(/^[a-f0-9]{64}$/);

    const list = await agent.get(`/api/operator/campaigns/${campaignId.toString()}/licences`);
    const row = list.body.licences.find(
      (l: { creatorId: string }) => l.creatorId === creatorId.toString(),
    );
    expect(row.state).toBe('awaiting_creator');
    expect(row.usableNow).toBe(false);
    expect(row.needsAttention).toBe(true);
  });

  /**
   * There is no operator route that writes grantedAt. Proven by exercising the
   * whole operator surface for this resource rather than by reading the file.
   */
  it('gives the operator no way to record a grant', async () => {
    const agent = await operator();
    const { id } = await requestLicence(agent);

    for (const path of [
      `/api/operator/licences/${id}/grant`,
      `/api/operator/licences/${id}`,
      `/api/operator/licences/${id}/approve`,
    ]) {
      const res = await agent.post(path).send({ agree: true });
      expect([404, 400]).toContain(res.status);
    }
    expect((await ContentLicenseModel.findById(id).lean())?.grantedAt).toBeNull();
  });

  it('the creator grants it, and then it is in force', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);

    const creator = await creatorAgent();
    const mine = await creator.get('/api/creator/licences');
    expect(mine.body.licences[0].needsYourDecision).toBe(true);
    expect(mine.body.licences[0].termsSha256).toBe(termsSha256);

    const granted = await creator
      .post(`/api/creator/licences/${id}/grant`)
      .send({ termsSha256, agree: true });
    expect(granted.status).toBe(200);

    const doc = await ContentLicenseModel.findById(id).lean();
    expect(doc?.grantedAt).not.toBeNull();
    expect(doc?.grantMethod).toBe('web_form');
    expect(doc?.grantIpHash).toMatch(/^[a-f0-9]{64}$/);

    const list = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/licences`);
    const row = list.body.licences.find(
      (l: { creatorId: string }) => l.creatorId === creatorId.toString(),
    );
    expect(row.state).toBe('active');
    expect(row.usableNow).toBe(true);
  });

  it('a creator cannot grant another creator’s licence', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);

    const tom = await creatorAgent(otherCreatorId);
    const res = await tom.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });
    expect(res.status).toBe(404);
    expect((await ContentLicenseModel.findById(id).lean())?.grantedAt).toBeNull();
  });

  it('refuses a grant against terms that have since changed', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);

    // The operator revises the request while the creator has the page open.
    await requestLicence(ops, { permittedUses: ['organic_reshare', 'paid_amplification', 'print'] });

    const creator = await creatorAgent();
    const res = await creator
      .post(`/api/creator/licences/${id}/grant`)
      .send({ termsSha256, agree: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('terms_changed');
    expect((await ContentLicenseModel.findById(id).lean())?.grantedAt).toBeNull();
  });

  it('will not grant twice', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });
    const again = await creator
      .post(`/api/creator/licences/${id}/grant`)
      .send({ termsSha256, agree: true });
    expect(again.status).toBe(409);
  });

  it('refuses to re-propose terms under a creator who already agreed', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });

    const res = await ops.post('/api/operator/licences/request').send({
      campaignCreatorId: joinId.toString(),
      postIds: [postId.toString()],
      ...REQUEST_BODY,
      permittedUses: ['organic_reshare', 'paid_amplification', 'print'],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('already_granted');
  });
});

/* --------------------------------------------------------------- the terms */

describe('what the creator is shown', () => {
  it('spells out each right in plain words', async () => {
    const ops = await operator();
    await requestLicence(ops, {
      permittedUses: ['organic_reshare', 'paid_amplification'],
      modificationPermitted: true,
      nameAndLikenessPermitted: true,
      whitelistingPermitted: true,
      territory: ['GB', 'IE'],
    });

    const creator = await creatorAgent();
    const res = await creator.get('/api/creator/licences');
    const points: string[] = res.body.licences[0].points;
    const all = points.join(' | ');

    expect(all).toContain('Run as a paid ad');
    expect(all).toContain('labelled as an ad');
    expect(all).toContain('Only in: GB, IE');
    expect(all).toContain('cut, edit, or re-caption');
    expect(all).toContain('your name and your face');
    expect(all).toContain('ads from your handle');
  });

  /** The single most consequential term on the page. */
  it('says "no end date" in words rather than as an absent field', async () => {
    const ops = await operator();
    await requestLicence(ops, { endsAt: null });
    const creator = await creatorAgent();
    const res = await creator.get('/api/creator/licences');
    expect(res.body.licences[0].points.join(' ')).toContain('does not expire');
    expect(res.body.licences[0].isPerpetual).toBe(true);
  });

  it('says explicitly when editing is NOT permitted', async () => {
    const ops = await operator();
    await requestLicence(ops, { modificationPermitted: false });
    const creator = await creatorAgent();
    const res = await creator.get('/api/creator/licences');
    expect(res.body.licences[0].points.join(' ')).toContain('cannot edit or recut');
  });
});

/* ------------------------------------------------------------ withdrawal */

describe('withdrawal', () => {
  it('lets the creator withdraw without giving a reason', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops);
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });

    const res = await creator.post(`/api/creator/licences/${id}/withdraw`).send({});
    expect(res.status).toBe(200);

    const doc = await ContentLicenseModel.findById(id).lean();
    expect(doc?.revokedAt).not.toBeNull();
    // The grant stays on the record. It happened.
    expect(doc?.grantedAt).not.toBeNull();

    const list = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/licences`);
    const row = list.body.licences.find(
      (l: { creatorId: string }) => l.creatorId === creatorId.toString(),
    );
    expect(row.state).toBe('revoked');
    expect(row.usableNow).toBe(false);
  });

  it('lets an operator withdraw, but requires a reason from them', async () => {
    const ops = await operator();
    const { id } = await requestLicence(ops);

    const noReason = await ops.post(`/api/operator/licences/${id}/revoke`).send({ reason: '' });
    expect(noReason.status).toBe(400);

    const res = await ops
      .post(`/api/operator/licences/${id}/revoke`)
      .send({ reason: 'the brand pulled the campaign' });
    expect(res.status).toBe(200);
  });

  it('will not withdraw the same licence twice', async () => {
    const ops = await operator();
    const { id } = await requestLicence(ops);
    await ops.post(`/api/operator/licences/${id}/revoke`).send({ reason: 'x' });
    const again = await ops.post(`/api/operator/licences/${id}/revoke`).send({ reason: 'x' });
    expect(again.status).toBe(404);
  });
});

/* ----------------------------------------------------- ad authorisation */

describe('ad authorisation', () => {
  async function licensedForAds(): Promise<TestAgent> {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops, {
      permittedUses: ['organic_reshare', 'paid_amplification'],
    });
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });
    return creator;
  }

  it('accepts a code from the creator once ads are licensed', async () => {
    const creator = await licensedForAds();
    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: '#SPARK_ABC123', expiresAt: soon(30).toISOString() });
    expect(res.status).toBe(201);

    const post = await PostModel.findById(postId).lean();
    expect(post?.adAuthorisations).toHaveLength(1);
    expect(post?.adAuthorisations[0]?.code).toBe('#SPARK_ABC123');
  });

  /**
   * The failure this whole step exists to stop: a code without a licence
   * permitting ads would let a brand run an ad the creator never agreed to.
   */
  it('refuses a code when the licence does not permit ads', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops, { permittedUses: ['organic_reshare'] });
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });

    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK123', expiresAt: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ads_not_licensed');
    expect((await PostModel.findById(postId).lean())?.adAuthorisations).toHaveLength(0);
  });

  it('refuses a code with no licence at all', async () => {
    const creator = await creatorAgent();
    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK123', expiresAt: null });
    expect(res.status).toBe(403);
  });

  it('refuses a code on someone else’s post', async () => {
    const creator = await licensedForAds();
    const res = await creator
      .post(`/api/creator/posts/${otherPostId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK123', expiresAt: null });
    expect(res.status).toBe(404);
  });

  it('rejects a code that has already expired', async () => {
    const creator = await licensedForAds();
    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK123', expiresAt: AUG(1).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('already_expired');
  });

  it('rejects a pasted code with a space in it', async () => {
    const creator = await licensedForAds();
    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK ABC', expiresAt: null });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('space');
  });

  it('supersedes an old code rather than replacing it', async () => {
    const creator = await licensedForAds();
    const path = `/api/creator/posts/${postId.toString()}/ad-authorisation`;
    await creator.post(path).send({ platform: 'tiktok_spark', code: 'OLD1', expiresAt: null });
    await creator.post(path).send({ platform: 'tiktok_spark', code: 'NEW1', expiresAt: null });

    const post = await PostModel.findById(postId).lean();
    expect(post?.adAuthorisations).toHaveLength(2);
    const live = post?.adAuthorisations.filter((a) => a.revokedAt == null);
    expect(live).toHaveLength(1);
    expect(live?.[0]?.code).toBe('NEW1');
    // The old one is kept, marked, and explains itself.
    const old = post?.adAuthorisations.find((a) => a.code === 'OLD1');
    expect(old?.revokedAt).not.toBeNull();
    expect(old?.revokedReason).toContain('replaced');
  });

  it('lets the creator withdraw a code without withdrawing the licence', async () => {
    const creator = await licensedForAds();
    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK1', expiresAt: null });

    const res = await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation/withdraw`)
      .send({});
    expect(res.status).toBe(200);

    const post = await PostModel.findById(postId).lean();
    expect(post?.adAuthorisations.every((a) => a.revokedAt != null)).toBe(true);
    // The licence itself is untouched.
    const licence = await ContentLicenseModel.findOne({ creatorId }).lean();
    expect(licence?.revokedAt).toBeNull();
  });

  /** The code is a credential for spending money. It is not logged. */
  it('never writes the code into the audit log', async () => {
    const creator = await licensedForAds();
    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SECRET-SPARK-CODE', expiresAt: null });

    const entries = await AuditLogModel.find({}).lean();
    expect(JSON.stringify(entries)).not.toContain('SECRET-SPARK-CODE');
    expect(entries.some((e) => e.action === 'ad_authorisation.provided')).toBe(true);
  });

  it('never returns the code to the creator either', async () => {
    const creator = await licensedForAds();
    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SECRET-SPARK-CODE', expiresAt: null });

    const res = await creator.get('/api/creator/ad-authorisations');
    expect(res.status).toBe(200);
    expect(res.body.posts[0].live).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('SECRET-SPARK-CODE');
  });
});

/* ------------------------------------------------------------ readiness */

describe('ad readiness for the operator', () => {
  it('reports which posts can run and what is missing where they cannot', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops, {
      permittedUses: ['organic_reshare', 'paid_amplification'],
    });
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });

    const before = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/ad-readiness`);
    const amaraRow = before.body.posts.find(
      (p: { postId: string }) => p.postId === postId.toString(),
    );
    // Licensed, but no code yet.
    expect(amaraRow.ready).toBe(false);
    expect(amaraRow.blockers).toEqual(['no_ad_code']);
    expect(amaraRow.code).toBeNull();

    // Tom has neither.
    const tomRow = before.body.posts.find(
      (p: { postId: string }) => p.postId === otherPostId.toString(),
    );
    expect(tomRow.blockers).toEqual(['no_licence', 'no_ad_code']);

    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK-OK', expiresAt: soon(20).toISOString() });

    const after = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/ad-readiness`);
    const ready = after.body.posts.find((p: { postId: string }) => p.postId === postId.toString());
    expect(ready.ready).toBe(true);
    // Only released once everything lines up.
    expect(ready.code).toBe('SPARK-OK');
    expect(after.body.counts.ready).toBe(1);
    expect(after.body.counts.blocked).toBe(1);
  });

  it('withholds the code as soon as the licence is withdrawn', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops, {
      permittedUses: ['paid_amplification'],
    });
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });
    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK-OK', expiresAt: null });

    await creator.post(`/api/creator/licences/${id}/withdraw`).send({});

    const res = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/ad-readiness`);
    const row = res.body.posts.find((p: { postId: string }) => p.postId === postId.toString());
    expect(row.ready).toBe(false);
    expect(row.blockers).toContain('no_licence');
    expect(row.code).toBeNull();
  });

  it('counts codes expiring soon', async () => {
    const ops = await operator();
    const { id, termsSha256 } = await requestLicence(ops, {
      permittedUses: ['paid_amplification'],
    });
    const creator = await creatorAgent();
    await creator.post(`/api/creator/licences/${id}/grant`).send({ termsSha256, agree: true });
    await creator
      .post(`/api/creator/posts/${postId.toString()}/ad-authorisation`)
      .send({ platform: 'tiktok_spark', code: 'SPARK-SOON', expiresAt: soon(3).toISOString() });

    const res = await ops.get(`/api/operator/campaigns/${campaignId.toString()}/ad-readiness`);
    expect(res.body.counts.expiringWithin14Days).toBe(1);
  });
});

/* ------------------------------------------------------------- validation */

describe('request validation', () => {
  it('refuses a request naming another creator’s post', async () => {
    const agent = await operator();
    const res = await agent.post('/api/operator/licences/request').send({
      campaignCreatorId: joinId.toString(),
      postIds: [otherPostId.toString()],
      ...REQUEST_BODY,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('posts_not_theirs');
  });

  it('refuses a named-posts request naming no posts', async () => {
    const agent = await operator();
    const res = await agent.post('/api/operator/licences/request').send({
      campaignCreatorId: joinId.toString(),
      postIds: [],
      ...REQUEST_BODY,
    });
    expect(res.status).toBe(400);
  });

  it('refuses a request with no uses, no territory, or backwards dates', async () => {
    const agent = await operator();
    const base = { campaignCreatorId: joinId.toString(), postIds: [postId.toString()], ...REQUEST_BODY };

    expect(
      (await agent.post('/api/operator/licences/request').send({ ...base, permittedUses: [] })).status,
    ).toBe(400);
    expect(
      (await agent.post('/api/operator/licences/request').send({ ...base, territory: [] })).status,
    ).toBe(400);
    expect(
      (
        await agent.post('/api/operator/licences/request').send({
          ...base,
          startsAt: AUG(10).toISOString(),
          endsAt: AUG(5).toISOString(),
        })
      ).status,
    ).toBe(400);
  });

  it('lists every participant, including those with no licence at all', async () => {
    const agent = await operator();
    await requestLicence(agent);

    const res = await agent.get(`/api/operator/campaigns/${campaignId.toString()}/licences`);
    expect(res.body.licences).toHaveLength(2);
    const tom = res.body.licences.find(
      (l: { creatorId: string }) => l.creatorId === otherCreatorId.toString(),
    );
    // "We have no rights from Tom" is the answer an account manager needs.
    expect(tom.state).toBe('none');
    expect(tom.licenceId).toBeNull();
    expect(tom.permittedUses).toEqual([]);
  });
});

/* ------------------------------------------------------------------ auth */

describe('authentication', () => {
  it('refuses the operator routes without a session', async () => {
    expect((await request(app).post('/api/operator/licences/request').send({})).status).toBe(401);
    expect(
      (await request(app).get(`/api/operator/campaigns/${campaignId.toString()}/licences`)).status,
    ).toBe(401);
  });

  it('refuses the creator routes without a session', async () => {
    expect((await request(app).get('/api/creator/licences')).status).toBe(401);
    expect(
      (await request(app).post(`/api/creator/posts/${postId.toString()}/ad-authorisation`).send({}))
        .status,
    ).toBe(401);
  });
});
