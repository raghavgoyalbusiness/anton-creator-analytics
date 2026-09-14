import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Server } from 'node:http';
import * as OTPAuth from 'otpauth';
import { MIN_SAMPLE_FOR_DOMAIN_RATE } from '@anton/shared';
import { createApp } from '../app.js';
import { closeTestServer, listenForTests } from '../testing/server.js';
import { connectDb, disconnectDb } from '../db/connect.js';
import {
  AuditLogModel,
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  OperatorModel,
  PostModel,
  SessionModel,
  ShareLinkModel,
} from '../db/models/index.js';
import { AttributionModel } from '../db/models/Attribution.js';
import { IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Server;
let operatorId: Types.ObjectId;
let brandId: Types.ObjectId;
let campaignId: Types.ObjectId;
let batchId: Types.ObjectId;

const PASSWORD = 'trust-test-password';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day, 12, 0, 0));

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
    .send({ email: 'trust@anton.example', password: PASSWORD, totpCode: totp() });
  expect(res.status).toBe(200);
  return agent;
}

async function makeCreator(
  handle: string,
  domains: string[],
  reach: number | null,
): Promise<Types.ObjectId> {
  const creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: handle.replace('.', ' '),
    handles: [{ platform: 'instagram', handle }],
    status: 'active',
    trustDomains: domains,
  });
  await CampaignCreatorModel.create({ campaignId, creatorId, status: 'reported' });

  if (reach !== null) {
    await PostModel.create({
      creatorId,
      campaignId,
      platform: 'instagram',
      format: 'reel',
      postedAt: AUG(4),
      publicUrl: `https://instagram.com/p/${handle}`,
      metricSource: 'screenshot',
      metrics: { reach },
      extraction: {
        sourceImageKey: `k/${handle}`,
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
  }
  return creatorId;
}

/** Attributed orders, written directly: attribution itself is tested elsewhere. */
async function attributeOrders(creatorId: Types.ObjectId, n: number, prefix: string): Promise<void> {
  const join = await CampaignCreatorModel.findOne({ campaignId, creatorId }).lean();
  for (let i = 0; i < n; i += 1) {
    const order = await OrderModel.create({
      brandId,
      externalOrderId: `${prefix}-${i}`,
      source: 'manual_csv',
      orderedAt: AUG(10),
      total: { amountMinor: 4_000, currency: 'GBP' },
      subtotal: { amountMinor: 4_000, currency: 'GBP' },
      currency: 'GBP',
      customerType: 'new',
      status: 'confirmed',
      ingestBatchId: batchId,
      ingestHistory: [{ batchId, at: new Date() }],
      rawRow: { id: `${prefix}-${i}` },
    });
    await AttributionModel.create({
      orderId: order._id,
      brandId,
      campaignId,
      campaignCreatorId: join?._id,
      creatorId,
      method: 'code_redemption',
      confidence: 'direct',
      attributedAt: new Date(),
      attributedValue: order.total,
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: order.subtotal,
    });
  }
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
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    AttributionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'trust@anton.example',
    displayName: 'Trust Operator',
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
    endDate: AUG(31),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });
  batchId = (
    await IngestBatchModel.create({
      brandId,
      source: 'manual_csv',
      status: 'committed',
      uploadedByOperatorId: operatorId,
    })
  )._id;
});

describe('tagging', () => {
  it('folds, dedupes and stores the domains, recording who tagged them', async () => {
    const creatorId = await makeCreator('amara.bell', [], null);
    const agent = await operator();

    const res = await agent
      .put(`/api/operator/creators/${creatorId.toString()}/trust-domains`)
      .send({ domains: ['Budget Picks', 'budget-picks', 'Ingredient Science'] });
    expect(res.status).toBe(200);
    expect(res.body.domains).toEqual([
      { key: 'budget_picks', label: 'Budget picks' },
      { key: 'ingredient_science', label: 'Ingredient science' },
    ]);

    const doc = await CreatorModel.findById(creatorId).lean();
    expect(doc?.trustDomains).toEqual(['budget_picks', 'ingredient_science']);
    expect(doc?.trustDomainsTaggedByOperatorId?.toString()).toBe(operatorId.toString());
    expect(doc?.trustDomainsTaggedAt).not.toBeNull();
  });

  it('refuses more than three', async () => {
    const creatorId = await makeCreator('amara.bell', [], null);
    const agent = await operator();
    const res = await agent
      .put(`/api/operator/creators/${creatorId.toString()}/trust-domains`)
      .send({ domains: ['budget_picks', 'ingredient_science', 'sensitive_skin', 'transformation'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_trust_domains');
    expect((await CreatorModel.findById(creatorId).lean())?.trustDomains).toEqual([]);
  });

  it('accepts a custom domain', async () => {
    const creatorId = await makeCreator('amara.bell', [], null);
    const agent = await operator();
    const res = await agent
      .put(`/api/operator/creators/${creatorId.toString()}/trust-domains`)
      .send({ domains: ['Vegan swaps'] });
    expect(res.status).toBe(200);
    expect(res.body.domains[0]).toEqual({ key: 'vegan_swaps', label: 'Vegan swaps' });
  });

  it('clears the tags with an empty list', async () => {
    const creatorId = await makeCreator('amara.bell', ['budget_picks'], null);
    const agent = await operator();
    const res = await agent
      .put(`/api/operator/creators/${creatorId.toString()}/trust-domains`)
      .send({ domains: [] });
    expect(res.status).toBe(200);
    expect((await CreatorModel.findById(creatorId).lean())?.trustDomains).toEqual([]);
  });

  /** A retag moves this creator's orders between domain samples. */
  it('audits the before and after', async () => {
    const creatorId = await makeCreator('amara.bell', ['budget_picks'], null);
    const agent = await operator();
    await agent
      .put(`/api/operator/creators/${creatorId.toString()}/trust-domains`)
      .send({ domains: ['ingredient_science'] });
    const entry = await AuditLogModel.findOne({ action: 'creator.trust_domains.tagged' }).lean();
    expect(entry?.detail).toEqual({ before: ['budget_picks'], after: ['ingredient_science'] });
  });

  it('404s for an unknown creator', async () => {
    const agent = await operator();
    const res = await agent
      .put(`/api/operator/creators/${new Types.ObjectId().toString()}/trust-domains`)
      .send({ domains: ['budget_picks'] });
    expect(res.status).toBe(404);
  });

  it('lists seeded domains first, then custom ones in use with counts', async () => {
    await makeCreator('amara.bell', ['vegan_swaps', 'budget_picks'], null);
    await makeCreator('tom.yilmaz', ['vegan_swaps'], null);
    const agent = await operator();
    const res = await agent.get('/api/operator/trust-domains');
    expect(res.status).toBe(200);
    expect(res.body.domains[0].isSeed).toBe(true);
    expect(res.body.domains.find((d: { key: string }) => d.key === 'budget_picks').creators).toBe(1);
    const custom = res.body.domains.find((d: { key: string }) => d.key === 'vegan_swaps');
    expect(custom.isSeed).toBe(false);
    expect(custom.creators).toBe(2);
    expect(res.body.maxPerCreator).toBe(3);
    expect(res.body.minimumSampleForRate).toBe(MIN_SAMPLE_FOR_DOMAIN_RATE);
  });

  it('shows domains on the roster', async () => {
    await makeCreator('amara.bell', ['budget_picks'], null);
    const agent = await operator();
    const res = await agent.get('/api/operator/roster');
    const row = res.body.creators.find((c: { displayName: string }) => c.displayName === 'amara bell');
    expect(row.trustDomains).toEqual([{ key: 'budget_picks', label: 'Budget picks' }]);
  });
});

describe('the campaign breakdown', () => {
  it('suppresses the rate below the minimum sample and reports it at the minimum', async () => {
    const big = await makeCreator('amara.bell', ['budget_picks'], 50_000);
    const small = await makeCreator('tom.yilmaz', ['clinical_authority'], 50_000);
    await attributeOrders(big, MIN_SAMPLE_FOR_DOMAIN_RATE, 'A');
    await attributeOrders(small, 4, 'T');

    const agent = await operator();
    const res = await agent.get(`/api/operator/campaigns/${campaignId.toString()}/trust-domains`);
    expect(res.status).toBe(200);

    const budget = res.body.domains.find((d: { domain: string }) => d.domain === 'budget_picks');
    const clinical = res.body.domains.find((d: { domain: string }) => d.domain === 'clinical_authority');

    expect(budget.sampleSufficient).toBe(true);
    expect(budget.ordersPerThousandReach).toBe(0.5);

    expect(clinical.orders).toBe(4);
    expect(clinical.ordersPerThousandReach).toBeNull();
    expect(clinical.rateUnavailableReason).toContain(String(MIN_SAMPLE_FOR_DOMAIN_RATE));
  });

  /** A post still in review must not enlarge the denominator. */
  it('counts reach only from reportable posts', async () => {
    const creatorId = await makeCreator('amara.bell', ['budget_picks'], 50_000);
    await PostModel.create({
      creatorId,
      campaignId,
      platform: 'instagram',
      format: 'reel',
      postedAt: AUG(6),
      publicUrl: 'https://instagram.com/p/pending',
      metricSource: 'screenshot',
      metrics: { reach: 950_000 },
      extraction: {
        sourceImageKey: 'k/pending',
        sourceImageSha256: 'b'.repeat(64),
        extractedAt: AUG(6),
        model: 'stub',
        promptVersion: 'extract-v1',
        rawResponse: '{}',
        parseOk: true,
        status: 'needs_review',
        plausibility: { passed: true, violations: [], skipped: [] },
        fieldConfidence: {},
      },
      submittedAt: AUG(6),
    });
    await attributeOrders(creatorId, MIN_SAMPLE_FOR_DOMAIN_RATE, 'A');

    const agent = await operator();
    const res = await agent.get(`/api/operator/campaigns/${campaignId.toString()}/trust-domains`);
    // 25 per 50,000 — not 25 per 1,000,000.
    expect(res.body.domains[0].ordersPerThousandReach).toBe(0.5);
  });

  it('ignores superseded attributions and cancelled orders', async () => {
    const creatorId = await makeCreator('amara.bell', ['budget_picks'], 50_000);
    await attributeOrders(creatorId, 3, 'A');
    const [first, second] = await AttributionModel.find({}).lean();
    if (!first || !second) throw new Error('fixture: expected three attributions');
    await AttributionModel.collection.updateOne(
      { _id: first._id },
      { $set: { supersededBy: first._id } },
    );
    await OrderModel.updateOne({ _id: second.orderId }, { $set: { status: 'cancelled' } });

    const agent = await operator();
    const res = await agent.get(`/api/operator/campaigns/${campaignId.toString()}/trust-domains`);
    expect(res.body.domains[0].orders).toBe(1);
  });

  it('appears on the brand report when creators are tagged', async () => {
    const creatorId = await makeCreator('amara.bell', ['budget_picks'], 50_000);
    await attributeOrders(creatorId, 2, 'A');

    const agent = await operator();
    const link = await agent.post('/api/operator/share-links').send({
      campaignId: campaignId.toString(),
      label: 'Report',
      expiresInDays: 30,
    });
    const token = new URL(link.body.url).pathname.split('/').pop() ?? '';

    const res = await request(app).get(`/api/report/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.trustDomains.domains[0].domain).toBe('budget_picks');
    expect(res.body.trustDomains.domains[0].ordersPerThousandReach).toBeNull();
    expect(res.body.trustDomains.minimumSample).toBe(MIN_SAMPLE_FOR_DOMAIN_RATE);
  });

  it('refuses without a session', async () => {
    expect(
      (await request(app).get(`/api/operator/campaigns/${campaignId.toString()}/trust-domains`)).status,
    ).toBe(401);
  });
});
