import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Express } from 'express';
import * as OTPAuth from 'otpauth';
import { normaliseTypedCode } from '@anton/shared';
import { createApp } from '../app.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import {
  AuditLogModel,
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  OperatorModel,
  SessionModel,
} from '../db/models/index.js';
import { LinkClickModel, TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Express;
let operatorId: Types.ObjectId;
let brandA: Types.ObjectId;
let brandB: Types.ObjectId;
let campaignA: Types.ObjectId;
let campaignB: Types.ObjectId;
let joinA: Types.ObjectId;
let joinA2: Types.ObjectId;
let joinB: Types.ObjectId;

const PASSWORD = 'tracking-test-password';
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
    .send({ email: 'track@anton.example', password: PASSWORD, totpCode: code() });
  expect(res.status).toBe(200);
  return agent;
}

async function makeCampaign(brandId: Types.ObjectId, name: string): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await CampaignModel.create({
    _id: id,
    brandId,
    name,
    status: 'live',
    platforms: ['instagram'],
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-12-31T00:00:00Z'),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });
  return id;
}

async function makeCreatorJoin(
  campaignId: Types.ObjectId,
  handle: string,
): Promise<Types.ObjectId> {
  const creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: handle.replace('.', ' '),
    handles: [{ platform: 'instagram', handle }],
    status: 'active',
  });
  const join = await CampaignCreatorModel.create({ campaignId, creatorId, status: 'accepted' });
  return join._id;
}

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
    BrandModel.deleteMany({}),
    CreatorModel.deleteMany({}),
    CampaignModel.deleteMany({}),
    CampaignCreatorModel.deleteMany({}),
    TrackingAssetModel.deleteMany({}),
    LinkClickModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'track@anton.example',
    displayName: 'Tracking Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  brandA = new Types.ObjectId();
  brandB = new Types.ObjectId();
  await BrandModel.create({ _id: brandA, name: 'Brand A', defaultCurrency: 'GBP' });
  await BrandModel.create({ _id: brandB, name: 'Brand B', defaultCurrency: 'GBP' });

  campaignA = await makeCampaign(brandA, 'Campaign A');
  campaignB = await makeCampaign(brandB, 'Campaign B');

  joinA = await makeCreatorJoin(campaignA, 'amara.bell');
  joinA2 = await makeCreatorJoin(campaignA, 'tom.yilmaz');
  joinB = await makeCreatorJoin(campaignB, 'nia.castellan');
});

const codeBody = (campaignCreatorId: Types.ObjectId, extra: Record<string, unknown> = {}) => ({
  campaignCreatorId: campaignCreatorId.toString(),
  type: 'discount_code',
  commissionRateBps: 1000,
  commissionRateBasis: 'order_subtotal',
  ...extra,
});

/* ---------------------------------------------------------- issuing codes */

describe('issuing a discount code', () => {
  it('requires an operator session', async () => {
    const res = await request(app).post('/api/operator/tracking-assets').send(codeBody(joinA));
    expect(res.status).toBe(401);
  });

  it('generates a code prefixed with the creator handle', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    expect(res.status).toBe(201);
    expect(res.body.value).toMatch(/^AMARABELL[23456789BCDFGHJKMNPQRTVWXYZ]{5}$/);
    expect(res.body.type).toBe('discount_code');
    expect(res.body.shortCode).toBeNull();
  });

  it('honours an explicit stub', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(joinA, { codeStub: 'AMARA' }));
    expect(res.body.value.startsWith('AMARA')).toBe(true);
  });

  it('never puts an ambiguous character in the generated half', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(joinA, { codeStub: 'ZZ' }));
    const suffix = res.body.value.slice(2);
    for (const ch of ['0', 'O', '1', 'I', 'L']) expect(suffix).not.toContain(ch);
  });

  it('stores a folded match key alongside the display value', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    const stored = await TrackingAssetModel.findById(res.body.id).lean();
    expect(stored?.matchKey).toBe(normaliseTypedCode(res.body.value));
  });

  it('records the commission rate at issue, not by reference', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(joinA, { commissionRateBps: 1250 }));
    expect(res.body.commissionRateBps).toBe(1250);
    expect(res.body.commissionRateBasis).toBe('order_subtotal');
  });

  it('rejects a fractional rate', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(joinA, { commissionRateBps: 0.125 }));
    expect(res.status).toBe(400);
  });

  it('rejects a rate above 100%', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(joinA, { commissionRateBps: 10_001 }));
    expect(res.status).toBe(400);
  });

  it('refuses a second live code for the same creator on the same campaign', async () => {
    const agent = await signedIn();
    expect((await agent.post('/api/operator/tracking-assets').send(codeBody(joinA))).status).toBe(201);

    const second = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    // Two live codes split a creator's own attribution and nobody can tell why.
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('asset_already_issued');
  });

  it('allows a new code once the old one is revoked', async () => {
    const agent = await signedIn();
    const first = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    await agent
      .post(`/api/operator/tracking-assets/${first.body.id}/revoke`)
      .send({ reason: 'creator asked for a memorable one' });

    const second = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    expect(second.status).toBe(201);
    expect(second.body.value).not.toBe(first.body.value);
  });

  it('refuses a join that does not exist', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(codeBody(new Types.ObjectId()));
    expect(res.status).toBe(404);
  });
});

/* --------------------------------------------------------- code collisions */

describe('code uniqueness', () => {
  it('is enforced per brand by a unique index', async () => {
    const agent = await signedIn();
    const issued = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));

    // Force the collision the generator would normally avoid.
    await expect(
      TrackingAssetModel.create({
        campaignCreatorId: joinA2,
        campaignId: campaignA,
        creatorId: new Types.ObjectId(),
        brandId: brandA,
        type: 'discount_code',
        value: issued.body.value,
        matchKey: normaliseTypedCode(issued.body.value),
        issuedAt: new Date(),
        activeFrom: new Date(),
        activeUntil: null,
        status: 'active',
        commissionRateBps: 1000,
        commissionRateBasis: 'order_subtotal',
        issuedByOperatorId: operatorId,
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('permits the same code string across two different brands', async () => {
    const agent = await signedIn();
    const issued = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));

    // Brand B's checkout is a separate namespace; an order carries its brand.
    const created = await TrackingAssetModel.create({
      campaignCreatorId: joinB,
      campaignId: campaignB,
      creatorId: new Types.ObjectId(),
      brandId: brandB,
      type: 'discount_code',
      value: issued.body.value,
      matchKey: normaliseTypedCode(issued.body.value),
      issuedAt: new Date(),
      activeFrom: new Date(),
      activeUntil: null,
      status: 'active',
      commissionRateBps: 1000,
      commissionRateBasis: 'order_subtotal',
      issuedByOperatorId: operatorId,
    });
    expect(created.brandId.toString()).toBe(brandB.toString());
  });

  it('a revoked code still blocks reuse of the same string', async () => {
    const agent = await signedIn();
    const first = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    await agent
      .post(`/api/operator/tracking-assets/${first.body.id}/revoke`)
      .send({ reason: 'done' });

    // Orders already attributed through it still point at it; the string must
    // never come back meaning someone else.
    const second = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    expect(second.body.value).not.toBe(first.body.value);
  });
});

/* -------------------------------------------------------- tracked links */

describe('issuing a tracked link', () => {
  const linkBody = (join: Types.ObjectId, url = 'https://brand.example/p/serum?variant=7') => ({
    campaignCreatorId: join.toString(),
    type: 'tracked_link',
    destinationUrl: url,
    commissionRateBps: 1000,
    commissionRateBasis: 'order_total',
  });

  it('mints a short code and a UTM-tagged destination', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/tracking-assets').send(linkBody(joinA));
    expect(res.status).toBe(201);
    expect(res.body.shortCode).toMatch(/^[23456789BCDFGHJKMNPQRTVWXYZ]{7}$/);
    expect(res.body.shareUrl).toContain(`/t/${res.body.shortCode}`);

    const tracked = new URL(res.body.value);
    expect(tracked.searchParams.get('anton_ref')).toBe(res.body.shortCode);
    expect(tracked.searchParams.get('utm_content')).toBe('amara.bell');
    // The brand's own parameter survives.
    expect(tracked.searchParams.get('variant')).toBe('7');
  });

  it('refuses a link with no destination', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/tracking-assets').send({
      campaignCreatorId: joinA.toString(),
      type: 'tracked_link',
      commissionRateBps: 1000,
      commissionRateBasis: 'order_total',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a non-http destination', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/operator/tracking-assets')
      .send(linkBody(joinA, 'javascript:alert(1)'));
    expect(res.status).toBe(400);
  });

  it('short codes are globally unique', async () => {
    const agent = await signedIn();
    const a = await agent.post('/api/operator/tracking-assets').send(linkBody(joinA));
    const b = await agent.post('/api/operator/tracking-assets').send(linkBody(joinA2));
    expect(a.body.shortCode).not.toBe(b.body.shortCode);
  });
});

/* -------------------------------------------------------- the redirect */

describe('the short-link redirect', () => {
  async function makeLink(): Promise<{ shortCode: string; id: string }> {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/tracking-assets').send({
      campaignCreatorId: joinA.toString(),
      type: 'tracked_link',
      destinationUrl: 'https://brand.example/p/serum',
      commissionRateBps: 1000,
      commissionRateBasis: 'order_total',
    });
    return { shortCode: res.body.shortCode, id: res.body.id };
  }

  it('redirects to the tracked URL and records a click', async () => {
    const { shortCode } = await makeLink();
    const res = await request(app).get(`/t/${shortCode}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('brand.example');
    expect(res.headers.location).toContain('anton_ref');

    const clicks = await LinkClickModel.find({}).lean();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.visitorHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('never stores a raw IP', async () => {
    const { shortCode } = await makeLink();
    await request(app).get(`/t/${shortCode}`).set('X-Forwarded-For', '203.0.113.9');
    const click = await LinkClickModel.findOne({}).lean();
    expect(JSON.stringify(click)).not.toContain('203.0.113.9');
  });

  it('records only a coarse device family, not a fingerprint', async () => {
    const { shortCode } = await makeLink();
    await request(app)
      .get(`/t/${shortCode}`)
      .set('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) CriOS/130 Safari/604.1');
    const click = await LinkClickModel.findOne({}).lean();
    expect(click?.userAgentFamily).toBe('Chrome on iOS');
    expect(click?.userAgentFamily?.length).toBeLessThan(30);
  });

  it('is case-insensitive on the short code', async () => {
    const { shortCode } = await makeLink();
    const res = await request(app).get(`/t/${shortCode.toLowerCase()}`);
    expect(res.status).toBe(302);
  });

  it('404s an unknown code without touching the database hard', async () => {
    expect((await request(app).get('/t/ZZZZZZZ')).status).toBe(404);
    expect((await request(app).get('/t/!!')).status).toBe(404);
  });

  it('still forwards a revoked link but records no click', async () => {
    const { shortCode, id } = await makeLink();
    const agent = await signedIn();
    await agent.post(`/api/operator/tracking-assets/${id}/revoke`).send({ reason: 'ended' });

    const res = await request(app).get(`/t/${shortCode}`);
    // The visitor did nothing wrong; a dead end costs the brand a sale.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://brand.example/p/serum');
    // But no commission can accrue from it.
    expect(await LinkClickModel.countDocuments({})).toBe(0);
  });

  it('does not leak the referrer onward', async () => {
    const { shortCode } = await makeLink();
    const res = await request(app).get(`/t/${shortCode}`);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('rate limits a hammering visitor', async () => {
    const { shortCode } = await makeLink();
    for (let i = 0; i < 30; i += 1) await request(app).get(`/t/${shortCode}`);
    const clicks = await LinkClickModel.countDocuments({});
    // Redirects keep working; clicks stop being counted.
    expect(clicks).toBeLessThanOrEqual(20);
  });
});

/* ---------------------------------------------------------- listing, audit */

describe('listing and audit', () => {
  it('lists active assets with click counts', async () => {
    const agent = await signedIn();
    await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    const res = await agent.get('/api/operator/tracking-assets');
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].creator.handle).toBe('amara.bell');
    expect(res.body.assets[0].clicks).toBe(0);
  });

  it('filters by campaign', async () => {
    const agent = await signedIn();
    await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    await agent.post('/api/operator/tracking-assets').send(codeBody(joinB));

    const res = await agent.get(`/api/operator/tracking-assets?campaignId=${campaignA.toString()}`);
    expect(res.body.assets).toHaveLength(1);
  });

  it('audits issue and revoke', async () => {
    const agent = await signedIn();
    const issued = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    await agent
      .post(`/api/operator/tracking-assets/${issued.body.id}/revoke`)
      .send({ reason: 'test' });

    const actions = (await AuditLogModel.find({}).lean()).map((a) => a.action);
    expect(actions).toContain('tracking_asset.issued');
    expect(actions).toContain('tracking_asset.revoked');
  });

  it('requires a reason to revoke', async () => {
    const agent = await signedIn();
    const issued = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    const res = await agent
      .post(`/api/operator/tracking-assets/${issued.body.id}/revoke`)
      .send({ reason: '' });
    expect(res.status).toBe(400);
  });

  it('cannot revoke the same asset twice', async () => {
    const agent = await signedIn();
    const issued = await agent.post('/api/operator/tracking-assets').send(codeBody(joinA));
    await agent.post(`/api/operator/tracking-assets/${issued.body.id}/revoke`).send({ reason: 'a' });
    const second = await agent
      .post(`/api/operator/tracking-assets/${issued.body.id}/revoke`)
      .send({ reason: 'b' });
    expect(second.status).toBe(404);
  });
});
