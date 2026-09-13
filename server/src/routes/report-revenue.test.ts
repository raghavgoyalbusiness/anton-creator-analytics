import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type TestAgent from 'supertest/lib/agent.js';
import { Types } from 'mongoose';
import type { Express } from 'express';
import * as OTPAuth from 'otpauth';
import { createApp } from '../app.js';
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
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { runAttribution } from '../attribution/run.js';
import { postCommission } from '../commission/post.js';

let app: Express;
let operatorId: Types.ObjectId;
let brandId: Types.ObjectId;
let campaignId: Types.ObjectId;
let otherCampaignId: Types.ObjectId;
let batchId: Types.ObjectId;

const PASSWORD = 'revenue-test-password';
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

async function signedIn(): Promise<TestAgent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/operator/auth/login')
    .send({ email: 'revenue@anton.example', password: PASSWORD, totpCode: totp() });
  expect(res.status).toBe(200);
  return agent;
}

async function makeShareLink(overrides: Record<string, unknown> = {}): Promise<string> {
  const agent = await signedIn();
  const res = await agent.post('/api/operator/share-links').send({
    campaignId: campaignId.toString(),
    label: 'Revenue report',
    expiresInDays: 30,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return new URL(res.body.url).pathname.split('/').pop() ?? '';
}

async function makeCampaign(name: string): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await CampaignModel.create({
    _id: id,
    brandId,
    name,
    status: 'live',
    platforms: ['instagram'],
    startDate: AUG(1),
    endDate: AUG(31),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 200_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });
  return id;
}

async function makeCreator(
  campaign: Types.ObjectId,
  handle: string,
  code: string,
  opts: { type?: 'discount_code' | 'tracked_link'; rateBps?: number; shortCode?: string } = {},
): Promise<{ join: Types.ObjectId; creator: Types.ObjectId }> {
  const creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: handle.replace('.', ' '),
    handles: [{ platform: 'instagram', handle }],
    status: 'active',
  });
  const join = await CampaignCreatorModel.create({
    campaignId: campaign,
    creatorId,
    status: 'reported',
    agreedRate: { amountMinor: 5_000, currency: 'GBP' },
  });
  const type = opts.type ?? 'discount_code';
  await TrackingAssetModel.create({
    campaignCreatorId: join._id,
    campaignId: campaign,
    creatorId,
    brandId,
    type,
    value: type === 'discount_code' ? code : `https://brand.example/?anton_ref=${opts.shortCode}`,
    shortCode: type === 'tracked_link' ? (opts.shortCode ?? 'NZJ6G6G') : null,
    destinationUrl: type === 'tracked_link' ? 'https://brand.example/shop' : null,
    issuedAt: AUG(1),
    activeFrom: AUG(1),
    status: 'active',
    commissionRateBps: opts.rateBps ?? 1000,
    commissionRateBasis: 'order_subtotal',
    issuedByOperatorId: operatorId,
  });
  return { join: join._id, creator: creatorId };
}

async function makeOrder(params: {
  externalOrderId: string;
  orderedAt?: Date;
  totalMinor?: number;
  discountCodeKey?: string | null;
  discountCodeUsed?: string | null;
  attributionRef?: string | null;
  status?: string;
  refundedMinor?: number | null;
  customerType?: string;
}): Promise<Types.ObjectId> {
  const total = params.totalMinor ?? 10_000;
  const doc = await OrderModel.create({
    brandId,
    externalOrderId: params.externalOrderId,
    source: 'manual_csv',
    orderedAt: params.orderedAt ?? AUG(10),
    total: { amountMinor: total, currency: 'GBP' },
    subtotal: { amountMinor: total, currency: 'GBP' },
    currency: 'GBP',
    discountCodeUsed: params.discountCodeUsed ?? params.discountCodeKey ?? null,
    discountCodeKey: params.discountCodeKey ?? null,
    attributionRef: params.attributionRef ?? null,
    customerType: params.customerType ?? 'new',
    status: params.status ?? 'confirmed',
    refundedAmount:
      params.refundedMinor != null ? { amountMinor: params.refundedMinor, currency: 'GBP' } : null,
    ingestBatchId: batchId,
    ingestHistory: [{ batchId, at: new Date() }],
    rawRow: { id: params.externalOrderId, 'Customer email': 'buyer@example.invalid' },
  });
  return doc._id;
}

async function runEverything(): Promise<void> {
  await runAttribution({ brandId });
  await postCommission({ brandId, createdBy: 'test' });
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
    PostModel.deleteMany({}),
    ShareLinkModel.deleteMany({}),
    SessionModel.deleteMany({}),
    TrackingAssetModel.deleteMany({}),
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    AttributionModel.deleteMany({}),
    AttributionConflictModel.deleteMany({}),
    CommissionEntryModel.collection.deleteMany({}),
    PaymentRecordModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'revenue@anton.example',
    displayName: 'Revenue Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  brandId = new Types.ObjectId();
  await BrandModel.create({ _id: brandId, name: 'Kelp & Co', defaultCurrency: 'GBP' });

  campaignId = await makeCampaign('Barrier Serum Launch');
  otherCampaignId = await makeCampaign('Winter Restock');

  await makeCreator(campaignId, 'amara.bell', 'AMARA10');
  await makeCreator(campaignId, 'tom.yilmaz', 'TOMLINK', {
    type: 'tracked_link',
    shortCode: 'TVWXYZ2',
    rateBps: 500,
  });

  const batch = await IngestBatchModel.create({
    brandId,
    source: 'manual_csv',
    status: 'committed',
    uploadedByOperatorId: operatorId,
  });
  batchId = batch._id;
});

const report = async (token: string) => request(app).get(`/api/report/${token}`);

/* ------------------------------------------------------------- presence */

describe('the revenue section is always present', () => {
  it('renders with an honest zero when no orders have been supplied', async () => {
    const token = await makeShareLink();
    const res = await report(token);
    expect(res.status).toBe(200);
    expect(res.body.revenue).toBeDefined();
    expect(res.body.revenue.ordersSeen).toBe(0);
    expect(res.body.revenue.attributedRevenue.amountMinor).toBe(0);
    // Rendered rather than omitted: a section that disappears when the numbers
    // are bad teaches a brand to read its absence as bad news.
    expect(res.body.revenue.statements.coverage).toContain('nothing to attribute');
    expect(res.body.revenue.statements.causation).toBeTruthy();
  });

  it('carries the causation limit on every report', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runEverything();
    const token = await makeShareLink();
    const res = await report(token);

    expect(res.body.revenue.statements.causation).toContain('not a measurement of what caused');
    // And in the methodology block, so it survives a redesign of the section.
    expect(res.body.methodology.attribution).toContain('not a measurement of what caused');
    expect(res.body.methodology.attributionCoverage).toBeTruthy();
  });
});

/* -------------------------------------------------------------- figures */

describe('the figures', () => {
  it('matches attributed revenue, commission and coverage', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({ externalOrderId: '1002', discountCodeKey: 'AMARAJQ', totalMinor: 20_000 });
    await makeOrder({ externalOrderId: '1003', totalMinor: 50_000 });
    await runEverything();

    const res = await report(await makeShareLink());
    const r = res.body.revenue;

    expect(r.ordersSeen).toBe(3);
    expect(r.ordersAttributed).toBe(2);
    expect(r.attributedRevenue.amountMinor).toBe(30_000);
    expect(r.unattributedRevenue.amountMinor).toBe(50_000);
    expect(r.totalRevenueSeen.amountMinor).toBe(80_000);
    // 10% of each order's subtotal.
    expect(r.commissionOwed.amountMinor).toBe(3_000);
    expect(r.revenuePerCommissionUnit).toBe(10);
    expect(r.coverageBps).toBe(6_667);
    expect(r.averageOrderValue.amountMinor).toBe(15_000);
  });

  /**
   * The commission the brand is shown must be the commission the creator is
   * shown. They talk to each other.
   */
  it('takes commission from the ledger, not from a recomputed rate', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runEverything();

    // A refund reverses part of the accrual in the ledger.
    await OrderModel.updateOne(
      { externalOrderId: '1001' },
      {
        $set: {
          status: 'partially_refunded',
          refundedAmount: { amountMinor: 5_000, currency: 'GBP' },
        },
      },
    );
    await runEverything();

    const res = await report(await makeShareLink());
    // 1000 accrued, 500 reversed. The rate alone would still say 1000.
    expect(res.body.revenue.commissionOwed.amountMinor).toBe(500);
  });

  it('reports gross and net of refunds separately', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({
      externalOrderId: '1002',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
      status: 'refunded',
      refundedMinor: 10_000,
    });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.attributedRevenue.amountMinor).toBe(20_000);
    expect(r.attributedRevenueNetOfRefunds.amountMinor).toBe(10_000);
    expect(r.refundedOrders).toBe(1);
    expect(r.statements.refunds).toContain('reversed in the ledger');
  });

  it('splits customer type, keeping unknown as its own bucket', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', customerType: 'new' });
    await makeOrder({ externalOrderId: '1002', discountCodeKey: 'AMARAJQ', customerType: 'returning' });
    await makeOrder({ externalOrderId: '1003', discountCodeKey: 'AMARAJQ', customerType: 'unknown' });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.newCustomerOrders).toBe(1);
    expect(r.returningCustomerOrders).toBe(1);
    expect(r.unknownCustomerTypeOrders).toBe(1);
  });
});

/* ------------------------------------------------------ method breakdown */

describe('the attribution method breakdown', () => {
  it('is present and splits direct from inferred', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 7_500 });
    await makeOrder({ externalOrderId: '1002', attributionRef: 'TVWXYZ2', totalMinor: 2_500 });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    const code = r.byMethod.find((m: { method: string }) => m.method === 'code_redemption');
    const link = r.byMethod.find((m: { method: string }) => m.method === 'link_last_touch');

    expect(code.confidence).toBe('direct');
    expect(link.confidence).toBe('inferred');
    expect(code.shareOfAttributedBps).toBe(7_500);
    expect(link.shareOfAttributedBps).toBe(2_500);
    // Shares are of attributed revenue and must sum to 100%.
    expect(
      r.byMethod.reduce((n: number, m: { shareOfAttributedBps: number }) => n + m.shareOfAttributedBps, 0),
    ).toBe(10_000);
  });

  it('warns in words when inferred attribution carries real weight', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 5_000 });
    await makeOrder({ externalOrderId: '1002', attributionRef: 'TVWXYZ2', totalMinor: 5_000 });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.statements.method).toContain('50.0%');
    expect(r.statements.method).toContain('tracked link');
  });

  it('carries an explanation for each method, not just a label', async () => {
    await makeOrder({ externalOrderId: '1002', attributionRef: 'TVWXYZ2' });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.byMethod[0].explanation).toContain('not proof');
  });
});

/* ---------------------------------------------------------- unattributed */

describe('unattributed orders are reported, not hidden', () => {
  it('counts them and explains each reason', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ externalOrderId: '1002' });
    await makeOrder({
      externalOrderId: '1003',
      discountCodeKey: 'AUTUMNJ5',
      discountCodeUsed: 'AUTUMN15',
    });
    await makeOrder({ externalOrderId: '1004', status: 'cancelled' });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.ordersUnattributed).toBe(3);

    const reasons = Object.fromEntries(
      r.unattributedReasons.map((x: { reason: string; orders: number }) => [x.reason, x.orders]),
    );
    expect(reasons['no creator code or link on the order']).toBe(1);
    expect(reasons['the order used a discount code that is not one of the creator codes we issued']).toBe(1);
    expect(reasons['the order was cancelled']).toBe(1);
  });

  it('names both halves in the coverage statement', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ externalOrderId: '1002' });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.statements.coverage).toContain('1 of 2');
    expect(r.statements.coverage).toContain('shown here rather than left out');
  });
});

/* --------------------------------------------------------------- scoping */

describe('scoping', () => {
  /**
   * A report describes one campaign. Revenue from another campaign in the same
   * window would inflate it with results nobody claimed for this one.
   */
  it('excludes orders attributed to a different campaign', async () => {
    await makeCreator(otherCampaignId, 'nia.castellan', 'NIA10');

    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({ externalOrderId: '2001', discountCodeKey: 'NJAJQ', totalMinor: 90_000 });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.attributedRevenue.amountMinor).toBe(10_000);
    // The other campaign's order is still SEEN — it is the brand's revenue in
    // the window — but it is not credited to this campaign.
    expect(r.ordersSeen).toBe(2);
    expect(r.ordersAttributed).toBe(1);
    expect(r.unattributedRevenue.amountMinor).toBe(90_000);
  });

  it('excludes orders outside the campaign window', async () => {
    await makeOrder({
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      orderedAt: new Date(Date.UTC(2026, 6, 15)),
    });
    await makeOrder({ externalOrderId: '1002', discountCodeKey: 'AMARAJQ', orderedAt: AUG(10) });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.ordersSeen).toBe(1);
  });

  /**
   * A campaign's endDate is a date, not an instant. Comparing against midnight
   * silently drops the final day, which is often the biggest.
   */
  it('includes orders placed on the last day of the campaign', async () => {
    await makeOrder({
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      orderedAt: new Date(Date.UTC(2026, 7, 31, 23, 30, 0)),
    });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.ordersSeen).toBe(1);
    expect(r.ordersAttributed).toBe(1);
  });
});

/* ------------------------------------------------------------- per creator */

describe('revenue by creator', () => {
  it('ranks creators by revenue with their own commission', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({ externalOrderId: '1002', attributionRef: 'TVWXYZ2', totalMinor: 40_000 });
    await runEverything();

    const r = (await report(await makeShareLink())).body.revenue;
    expect(r.byCreator).toHaveLength(2);
    // Largest first.
    expect(r.byCreator[0].handle).toBe('tom.yilmaz');
    expect(r.byCreator[0].revenue.amountMinor).toBe(40_000);
    // Tom's own rate is 5%, not Amara's 10%.
    expect(r.byCreator[0].commission.amountMinor).toBe(2_000);
    expect(r.byCreator[0].methods).toEqual(['link_last_touch']);

    expect(r.byCreator[1].handle).toBe('amara.bell');
    expect(r.byCreator[1].commission.amountMinor).toBe(1_000);
  });
});

/* ------------------------------------------------------------- privacy */

describe('what the brand share view must not carry', () => {
  /**
   * The brand supplied the orders, so their own customer data is not a secret
   * from them — but the share link is forwarded, and a report that carries a
   * customer list is a report that leaks one.
   */
  it('never includes a customer field or a raw order row', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runEverything();

    const res = await report(await makeShareLink());
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('buyer@example.invalid');
    expect(body).not.toContain('rawRow');
    expect(body).not.toContain('1001');
  });

  it('is reachable without a session, because that is the point of a share link', async () => {
    await makeOrder({ externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runEverything();
    const res = await request(app).get(`/api/report/${await makeShareLink()}`);
    expect(res.status).toBe(200);
    expect(res.body.revenue.ordersAttributed).toBe(1);
  });

  it('still refuses a revoked link', async () => {
    const token = await makeShareLink();
    const agent = await signedIn();
    const list = await agent.get('/api/operator/share-links');
    const id = list.body.links[0].id;
    await agent.post(`/api/operator/share-links/${id}/revoke`).send({});

    const res = await report(token);
    expect(res.status).toBe(410);
  });
});
