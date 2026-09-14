import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Server } from 'node:http';
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
  SessionModel,
} from '../db/models/index.js';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { mintToken } from '../lib/tokens.js';
import { runAttribution } from '../attribution/run.js';
import { postCommission } from '../commission/post.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { loadConsentDocument } from '../config/consent.js';

let app: Server;
let operatorId: Types.ObjectId;
let brandId: Types.ObjectId;
let campaignId: Types.ObjectId;
let creatorId: Types.ObjectId;
let otherCreatorId: Types.ObjectId;
let joinId: Types.ObjectId;
let batchId: Types.ObjectId;

const AUG = (day: number): Date => new Date(Date.UTC(2026, 7, day, 12, 0, 0));

/**
 * The customer details a real export carries. Nothing in this file may ever
 * appear in a creator-facing response, so every test checks against these.
 */
const CUSTOMER_PII = {
  'Customer name': 'Priya Raghunathan',
  'Customer email': 'priya.r@example.com',
  'Shipping address': '14 Bellwether Road, Leeds LS1 4AB',
  'Phone': '+44 7700 900123',
};

async function signedInCreator(): Promise<TestAgent> {
  const agent = request.agent(app);
  const minted = mintToken();
  await MagicLinkModel.create({
    tokenHash: minted.hash,
    creatorId,
    campaignId,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    issuedByOperatorId: operatorId,
  });
  const res = await agent.post('/api/creator/session/exchange').send({ token: minted.raw });
  expect(res.status).toBe(201);
  return agent;
}

async function makeOrder(params: {
  externalOrderId: string;
  totalMinor?: number;
  subtotalMinor?: number;
  discountCodeKey?: string | null;
  status?: string;
  refundedMinor?: number | null;
  currency?: string;
}): Promise<Types.ObjectId> {
  const total = params.totalMinor ?? 10_000;
  const currency = params.currency ?? 'GBP';
  const doc = await OrderModel.create({
    brandId,
    externalOrderId: params.externalOrderId,
    source: 'manual_csv',
    orderedAt: AUG(5),
    total: { amountMinor: total, currency },
    subtotal: { amountMinor: params.subtotalMinor ?? total, currency },
    currency,
    discountCodeUsed: params.discountCodeKey,
    discountCodeKey: params.discountCodeKey ?? null,
    customerType: 'new',
    status: params.status ?? 'confirmed',
    refundedAmount:
      params.refundedMinor != null ? { amountMinor: params.refundedMinor, currency } : null,
    ingestBatchId: batchId,
    ingestHistory: [{ batchId, at: new Date() }],
    // The row as the brand uploaded it, customer details and all.
    rawRow: { id: params.externalOrderId, ...CUSTOMER_PII },
  });
  return doc._id;
}

async function runEverything(): Promise<void> {
  await runAttribution({ brandId });
  await postCommission({ brandId, createdBy: 'test' });
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
    TrackingAssetModel.deleteMany({}),
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    AttributionModel.deleteMany({}),
    AttributionConflictModel.deleteMany({}),
    CommissionEntryModel.collection.deleteMany({}),
    PaymentRecordModel.deleteMany({}),
    SessionModel.deleteMany({}),
    MagicLinkModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'ops@anton.example',
    displayName: 'Ops',
    passwordHash: 'x',
    role: 'owner',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  brandId = new Types.ObjectId();
  await BrandModel.create({ _id: brandId, name: 'Lumen Skin', defaultCurrency: 'GBP' });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId,
    name: 'Autumn Reset',
    status: 'live',
    platforms: ['instagram'],
    startDate: AUG(1),
    endDate: new Date(Date.UTC(2026, 11, 31)),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });

  const consent = await loadConsentDocument();
  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Amara Bell',
    handles: [{ platform: 'instagram', handle: 'amara.bell' }],
    status: 'active',
    consent: {
      grantedAt: new Date('2026-08-01T00:00:00Z'),
      scopeVersion: consent.version,
      documentSha256: consent.sha256,
      method: 'web_form',
      ipHash: 'a'.repeat(64),
      withdrawnAt: null,
    },
  });

  otherCreatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: otherCreatorId,
    displayName: 'Tom Yilmaz',
    handles: [{ platform: 'instagram', handle: 'tom.yilmaz' }],
    status: 'active',
  });

  const join = await CampaignCreatorModel.create({ campaignId, creatorId, status: 'accepted' });
  joinId = join._id;
  const otherJoin = await CampaignCreatorModel.create({
    campaignId,
    creatorId: otherCreatorId,
    status: 'accepted',
  });

  await TrackingAssetModel.create({
    campaignCreatorId: joinId,
    campaignId,
    creatorId,
    brandId,
    type: 'discount_code',
    value: 'AMARA10',
    issuedAt: AUG(1),
    activeFrom: AUG(1),
    status: 'active',
    commissionRateBps: 1000,
    commissionRateBasis: 'order_subtotal',
    issuedByOperatorId: operatorId,
  });
  await TrackingAssetModel.create({
    campaignCreatorId: otherJoin._id,
    campaignId,
    creatorId: otherCreatorId,
    brandId,
    type: 'discount_code',
    value: 'TOM10',
    issuedAt: AUG(1),
    activeFrom: AUG(1),
    status: 'active',
    commissionRateBps: 2000,
    commissionRateBasis: 'order_subtotal',
    issuedByOperatorId: operatorId,
  });

  const batch = await IngestBatchModel.create({
    brandId,
    source: 'manual_csv',
    status: 'committed',
    uploadedByOperatorId: operatorId,
  });
  batchId = batch._id;
});

/* --------------------------------------------------------------- privacy */

describe('creators never see customer data', () => {
  it('returns no customer field from any order, anywhere in the response', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ externalOrderId: '1002', discountCodeKey: 'AMARAJQ', totalMinor: 4_500 });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    for (const value of Object.values(CUSTOMER_PII)) {
      expect(body).not.toContain(value);
    }
    // Not even the brand's own order reference, which is a handle onto the
    // customer in the brand's system.
    expect(body).not.toContain('1001');
    expect(body).not.toContain('rawRow');
  });

  it('keeps customer data out of the downloadable statement', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings/statement.csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    for (const value of Object.values(CUSTOMER_PII)) {
      expect(res.text).not.toContain(value);
    }
  });

  it('shows only this creator’s earnings, never another creator’s', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({ externalOrderId: '2001', discountCodeKey: 'TQMJQ', totalMinor: 50_000 });
    await runEverything();

    // Both creators did earn, so this test is actually proving isolation.
    expect(await CommissionEntryModel.countDocuments({ creatorId: otherCreatorId })).toBe(1);

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    expect(res.body.campaigns[0].earned.amountMinor).toBe(1_000);
    expect(res.body.campaigns[0].lines).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('Tom Yilmaz');
  });

  it('refuses without a session', async () => {
    for (const path of ['/api/creator/earnings', '/api/creator/tracking', '/api/creator/earnings/statement.csv']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});

/* -------------------------------------------------------------- figures */

describe('the earnings figures', () => {
  it('groups by campaign and shows earned, paid and outstanding', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({ externalOrderId: '1002', discountCodeKey: 'AMARAJQ', totalMinor: 25_000 });
    await runEverything();

    await PaymentRecordModel.create({
      creatorId,
      campaignId,
      brandId,
      amount: { amountMinor: 2_000, currency: 'GBP' },
      paidAt: AUG(20),
      recordedByOperatorId: operatorId,
      recordedAt: new Date(),
    });

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const group = res.body.campaigns[0];

    expect(group.campaignName).toBe('Autumn Reset');
    expect(group.brandName).toBe('Lumen Skin');
    expect(group.earned.amountMinor).toBe(3_500);
    expect(group.paid.amountMinor).toBe(2_000);
    expect(group.outstanding.amountMinor).toBe(1_500);
    expect(group.orderCount).toBe(2);
    expect(group.payments).toHaveLength(1);
  });

  it('shows the arithmetic on every line', async () => {
    await makeOrder({
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 12_000,
      subtotalMinor: 10_000,
    });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const line = res.body.campaigns[0].lines[0];

    expect(line.ratePercent).toBe(10);
    expect(line.rateBasis).toBe('order subtotal');
    expect(line.orderValue.amountMinor).toBe(12_000);
    expect(line.amount.amountMinor).toBe(1_000);
    expect(line.workings).toContain('10%');
    expect(line.amountFormatted).toContain('10');
  });

  it('explains in plain words how the order was credited', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const line = res.body.campaigns[0].lines[0];
    expect(line.attributionMethod).toBe('Your discount code was used at checkout');
    expect(line.attributionConfidence).toBe('direct');
  });

  /**
   * A refund must appear as its own line. A number that quietly shrinks
   * between two visits is the fastest way to lose a creator's trust.
   */
  it('shows a refund as a separate line, never as a number quietly changing', async () => {
    const orderId = await makeOrder({
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
    });
    await runEverything();

    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'refunded', refundedAmount: { amountMinor: 10_000, currency: 'GBP' } } },
    );
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const group = res.body.campaigns[0];

    expect(group.lines).toHaveLength(2);
    expect(group.lines[0].type).toBe('accrual');
    expect(group.lines[0].amount.amountMinor).toBe(1_000);
    expect(group.lines[1].type).toBe('reversal');
    expect(group.lines[1].amount.amountMinor).toBe(-1_000);
    expect(group.lines[1].reason).toBeTruthy();
    expect(group.earned.amountMinor).toBe(0);
    expect(group.reversalCount).toBe(1);
  });

  it('shows an adjustment with its reason', async () => {
    await CommissionEntryModel.create({
      creatorId,
      campaignId,
      campaignCreatorId: joinId,
      brandId,
      type: 'adjustment',
      amount: { amountMinor: 5_000, currency: 'GBP' },
      rateAppliedBps: 0,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 0, currency: 'GBP' },
      reason: 'Bonus for the highest-converting post.',
      createdBy: 'ops@anton.example',
    });

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const line = res.body.campaigns[0].lines[0];
    expect(line.type).toBe('adjustment');
    expect(line.reason).toContain('Bonus');
    expect(line.orderValue).toBeNull();
  });

  /**
   * Anton calculates money and never moves it. This must be said on the page
   * the creator reads, not in a footer, because a figure that looks like a
   * wallet balance and is not one is what gets misunderstood.
   */
  it('says plainly that Anton holds no money and the brand pays directly', async () => {
    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    expect(res.body.howThisWorks.whoPays).toContain('brand pays you directly');
    expect(res.body.howThisWorks.antonHoldsNothing).toContain('does not hold your money');
    expect(res.body.howThisWorks.whenFiguresChange).toContain('separate line');
  });

  it('refuses a single total across currencies and says why', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({
      externalOrderId: '1002',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
      currency: 'EUR',
    });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    const group = res.body.campaigns[0];
    expect(group.earned).toBeNull();
    expect(group.earnedByCurrency).toHaveLength(2);
    expect(group.unavailableReason).toContain('more than one currency');
  });

  it('is empty-safe for a creator who has earned nothing', async () => {
    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings');
    expect(res.status).toBe(200);
    expect(res.body.campaigns).toEqual([]);
  });
});

/* ------------------------------------------------------------- tracking */

describe('the creator’s own codes', () => {
  it('shows their code with the rate on it', async () => {
    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/tracking');
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(1);
    expect(res.body.assets[0].value).toBe('AMARA10');
    // Without their own rate, nothing on the earnings page is checkable.
    expect(res.body.assets[0].commissionRatePercent).toBe(10);
    expect(res.body.assets[0].commissionRateBasis).toBe('order subtotal');
    expect(res.body.assets[0].campaignName).toBe('Autumn Reset');
  });

  it('never shows another creator’s code', async () => {
    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/tracking');
    expect(JSON.stringify(res.body)).not.toContain('TOM10');
  });
});

/* ------------------------------------------------------------ statement */

describe('the statement', () => {
  it('carries the workings so an accountant can check every figure', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runEverything();

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings/statement.csv');
    const [header, first] = res.text.trim().split('\n');
    expect(header).toBe(
      'date,campaign,type,orderValueMinor,ratePercent,rateBasis,currency,amountMinor,workings,note',
    );
    expect(first).toContain('Autumn Reset');
    expect(first).toContain('accrual');
    expect(res.text).toContain('10%');
  });

  /**
   * The campaign name and the reason are both text somebody typed. This file
   * gets forwarded to an accountant, and a cell beginning with `=` executes
   * when they open it.
   */
  it('neutralises formula injection', async () => {
    await CampaignModel.updateOne(
      { _id: campaignId },
      { $set: { name: '=HYPERLINK("http://evil.test","claim")' } },
    );
    await CommissionEntryModel.create({
      creatorId,
      campaignId,
      campaignCreatorId: joinId,
      brandId,
      type: 'adjustment',
      amount: { amountMinor: 100, currency: 'GBP' },
      rateAppliedBps: 0,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 0, currency: 'GBP' },
      reason: '+1234567890',
      createdBy: 'test',
    });

    const agent = await signedInCreator();
    const res = await agent.get('/api/creator/earnings/statement.csv');
    expect(res.text).toContain("'=HYPERLINK");
    expect(res.text).toContain("'+1234567890");
    for (const line of res.text.trim().split('\n')) {
      for (const cell of line.split(',')) {
        expect(['=', '+', '@']).not.toContain(cell.replace(/^"/, '')[0] ?? '');
      }
    }
  });
});
