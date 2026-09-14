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
  OperatorModel,
  SessionModel,
} from '../db/models/index.js';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { ColumnMappingModel, IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { LinkClickModel, TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Server;
let operatorId: Types.ObjectId;
let brandA: Types.ObjectId;
let brandB: Types.ObjectId;
let campaignA: Types.ObjectId;
let campaignB: Types.ObjectId;
let joinAmara: Types.ObjectId;
let joinTom: Types.ObjectId;
let joinBrandB: Types.ObjectId;

const PASSWORD = 'attribution-test-password';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

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
    .send({ email: 'attrib@anton.example', password: PASSWORD, totpCode: totp() });
  expect(res.status).toBe(200);
  return agent;
}

const AUG = (day: number, hour = 12): Date => new Date(Date.UTC(2026, 7, day, hour, 0, 0));

async function makeCampaign(
  brandId: Types.ObjectId,
  name: string,
  windowHours: number | null = null,
): Promise<Types.ObjectId> {
  const id = new Types.ObjectId();
  await CampaignModel.create({
    _id: id,
    brandId,
    name,
    status: 'live',
    platforms: ['instagram'],
    startDate: AUG(1),
    endDate: new Date(Date.UTC(2026, 11, 31)),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'affiliate',
    currency: 'GBP',
    budgetTotal: { amountMinor: 100_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
    attributionWindowHours: windowHours,
  });
  return id;
}

async function makeJoin(campaignId: Types.ObjectId, handle: string): Promise<Types.ObjectId> {
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

/** Creates a tracking asset directly, so a test can control its dates exactly. */
async function makeAsset(params: {
  join: Types.ObjectId;
  brandId: Types.ObjectId;
  campaignId: Types.ObjectId;
  type: 'discount_code' | 'tracked_link';
  value: string;
  shortCode?: string;
  rateBps?: number;
  activeFrom?: Date;
  activeUntil?: Date | null;
  status?: string;
  revokedAt?: Date | null;
}): Promise<Types.ObjectId> {
  const join = await CampaignCreatorModel.findById(params.join).lean();
  const doc = await TrackingAssetModel.create({
    campaignCreatorId: params.join,
    campaignId: params.campaignId,
    creatorId: join?.creatorId,
    brandId: params.brandId,
    type: params.type,
    value: params.value,
    shortCode: params.type === 'tracked_link' ? (params.shortCode ?? 'NZJ6G6G') : null,
    destinationUrl: params.type === 'tracked_link' ? 'https://brand.example/shop' : null,
    issuedAt: params.activeFrom ?? AUG(1),
    activeFrom: params.activeFrom ?? AUG(1),
    activeUntil: params.activeUntil ?? null,
    status: params.status ?? 'active',
    revokedAt: params.revokedAt ?? null,
    commissionRateBps: params.rateBps ?? 1000,
    commissionRateBasis: 'order_subtotal',
    issuedByOperatorId: operatorId,
  });
  return doc._id;
}

let batchId: Types.ObjectId;

async function makeOrder(params: {
  brandId: Types.ObjectId;
  externalOrderId: string;
  orderedAt?: Date;
  totalMinor?: number;
  subtotalMinor?: number;
  discountCodeKey?: string | null;
  attributionRef?: string | null;
  status?: string;
  refundedMinor?: number | null;
}): Promise<Types.ObjectId> {
  const total = params.totalMinor ?? 12_000;
  const doc = await OrderModel.create({
    brandId: params.brandId,
    externalOrderId: params.externalOrderId,
    source: 'manual_csv',
    orderedAt: params.orderedAt ?? AUG(5),
    total: { amountMinor: total, currency: 'GBP' },
    subtotal: { amountMinor: params.subtotalMinor ?? total, currency: 'GBP' },
    currency: 'GBP',
    discountCodeUsed: params.discountCodeKey,
    discountCodeKey: params.discountCodeKey ?? null,
    attributionRef: params.attributionRef ?? null,
    customerType: 'new',
    status: params.status ?? 'confirmed',
    refundedAmount:
      params.refundedMinor != null ? { amountMinor: params.refundedMinor, currency: 'GBP' } : null,
    ingestBatchId: batchId,
    ingestHistory: [{ batchId, at: new Date() }],
    rawRow: { id: params.externalOrderId },
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
    TrackingAssetModel.deleteMany({}),
    LinkClickModel.deleteMany({}),
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    ColumnMappingModel.deleteMany({}),
    AttributionModel.deleteMany({}),
    AttributionConflictModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'attrib@anton.example',
    displayName: 'Attribution Operator',
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

  joinAmara = await makeJoin(campaignA, 'amara.bell');
  joinTom = await makeJoin(campaignA, 'tom.yilmaz');
  joinBrandB = await makeJoin(campaignB, 'nia.castellan');

  const batch = await IngestBatchModel.create({
    brandId: brandA,
    source: 'manual_csv',
    status: 'committed',
    uploadedByOperatorId: operatorId,
  });
  batchId = batch._id;
});

const runFor = async (agent: TestAgent, brandId: Types.ObjectId) =>
  agent.post(`/api/operator/brands/${brandId.toString()}/attribution/run`);

/* ---------------------------------------------------------- precedence */

describe('running attribution', () => {
  it('attributes a code redemption and records the terms on the row', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'discount_code',
      value: 'AMARA10',
      rateBps: 1250,
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 12_000,
      subtotalMinor: 10_000,
    });

    const res = await runFor(agent, brandA);
    expect(res.status).toBe(200);
    expect(res.body.attributed).toBe(1);
    expect(res.body.created).toBe(1);
    expect(res.body.byMethod.code_redemption).toBe(1);

    const row = await AttributionModel.findOne({ brandId: brandA }).lean();
    expect(row?.method).toBe('code_redemption');
    expect(row?.confidence).toBe('direct');
    // Terms copied at attribution time, so the ledger is reproducible later.
    expect(row?.rateAppliedBps).toBe(1250);
    expect(row?.rateBasis).toBe('order_subtotal');
    expect(row?.basisAmount.amountMinor).toBe(10_000);
    expect(row?.windowHoursUsed).toBe(168);
  });

  it('attributes a tracked link as inferred', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'tracked_link',
      value: 'https://brand.example/shop?anton_ref=NZJ6G6G',
      shortCode: 'NZJ6G6G',
    });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', attributionRef: 'NZJ6G6G' });

    await runFor(agent, brandA);
    const row = await AttributionModel.findOne({ brandId: brandA }).lean();
    expect(row?.method).toBe('link_last_touch');
    expect(row?.confidence).toBe('inferred');
  });

  it('logs a conflict when a code and a link point at different creators', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'discount_code',
      value: 'AMARA10',
    });
    await makeAsset({
      join: joinTom,
      brandId: brandA,
      campaignId: campaignA,
      type: 'tracked_link',
      value: 'https://brand.example/shop?anton_ref=TVWXYZ2',
      shortCode: 'TVWXYZ2',
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      attributionRef: 'TVWXYZ2',
    });

    const res = await runFor(agent, brandA);
    expect(res.body.conflictsLogged).toBe(1);

    const row = await AttributionModel.findOne({ brandId: brandA }).lean();
    // The code wins; the disagreement is recorded, not resolved silently.
    expect(row?.method).toBe('code_redemption');
    expect(row?.campaignCreatorId.toString()).toBe(joinAmara.toString());

    const conflict = await AttributionConflictModel.findOne({ brandId: brandA }).lean();
    expect(conflict?.winningCampaignCreatorId.toString()).toBe(joinAmara.toString());
    expect(conflict?.losingCampaignCreatorId.toString()).toBe(joinTom.toString());
    expect(conflict?.reviewedAt).toBeNull();
  });

  it('does not pile up duplicate conflicts across re-runs', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeAsset({
      join: joinTom,
      brandId: brandA,
      campaignId: campaignA,
      type: 'tracked_link',
      value: 'x',
      shortCode: 'TVWXYZ2',
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      attributionRef: 'TVWXYZ2',
    });

    await runFor(agent, brandA);
    const second = await runFor(agent, brandA);
    expect(second.body.conflictsLogged).toBe(0);
    expect(await AttributionConflictModel.countDocuments({})).toBe(1);
  });
});

/* --------------------------------------------------------- idempotency */

describe('idempotency', () => {
  it('re-running changes nothing and creates no second attribution', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ brandId: brandA, externalOrderId: '1002', discountCodeKey: 'AMARAJQ' });

    const first = await runFor(agent, brandA);
    expect(first.body.created).toBe(2);

    const second = await runFor(agent, brandA);
    expect(second.body.created).toBe(0);
    expect(second.body.unchanged).toBe(2);
    expect(second.body.superseded).toBe(0);
    expect(second.body.attributed).toBe(2);

    expect(await AttributionModel.countDocuments({ supersededBy: null })).toBe(2);
    expect(await AttributionModel.countDocuments({})).toBe(2);
  });

  /**
   * The database itself must refuse two live attributions on one order. A
   * duplicate here pays two creators for one sale.
   */
  it('cannot have two live attributions on one order', async () => {
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001' });
    const base = {
      orderId,
      brandId: brandA,
      campaignId: campaignA,
      campaignCreatorId: joinAmara,
      creatorId: new Types.ObjectId(),
      method: 'manual_assignment',
      confidence: 'direct',
      attributedAt: new Date(),
      attributedValue: { amountMinor: 100, currency: 'GBP' },
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 100, currency: 'GBP' },
    };
    await AttributionModel.create(base);
    await expect(AttributionModel.create(base)).rejects.toThrow(/duplicate key/i);
  });

  it('supersedes rather than edits when the decision changes', async () => {
    const agent = await signedIn();
    const assetId = await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'discount_code',
      value: 'AMARA10',
      rateBps: 1000,
    });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);

    // The rate on the asset is corrected.
    await TrackingAssetModel.updateOne({ _id: assetId }, { $set: { commissionRateBps: 1500 } });
    const second = await runFor(agent, brandA);

    expect(second.body.created).toBe(1);
    expect(second.body.superseded).toBe(1);
    expect(await AttributionModel.countDocuments({})).toBe(2);
    expect(await AttributionModel.countDocuments({ supersededBy: null })).toBe(1);

    const live = await AttributionModel.findOne({ supersededBy: null }).lean();
    expect(live?.rateAppliedBps).toBe(1500);

    // The old row survives, pointing at what replaced it.
    const old = await AttributionModel.findOne({ supersededBy: { $ne: null } }).lean();
    expect(old?.rateAppliedBps).toBe(1000);
    expect(old?.supersededBy?.toString()).toBe(live?._id.toString());
  });

  it('withdraws attribution when an asset is revoked after the fact', async () => {
    const agent = await signedIn();
    const assetId = await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);
    expect(await AttributionModel.countDocuments({ supersededBy: null })).toBe(1);

    await TrackingAssetModel.updateOne(
      { _id: assetId },
      { $set: { status: 'revoked', revokedAt: AUG(2), revokedReason: 'shared publicly' } },
    );
    const second = await runFor(agent, brandA);

    expect(second.body.attributed).toBe(0);
    expect(second.body.superseded).toBe(1);
    expect(await AttributionModel.countDocuments({ supersededBy: null })).toBe(0);
  });
});

/* ------------------------------------------------------------- windows */

describe('the attribution window', () => {
  it('uses the campaign window and stores it on the row', async () => {
    const agent = await signedIn();
    const shortWindow = await makeCampaign(brandA, 'Launch week', 24);
    const join = await makeJoin(shortWindow, 'kit.osei');
    await makeAsset({
      join,
      brandId: brandA,
      campaignId: shortWindow,
      type: 'discount_code',
      value: 'KIT10',
    });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'KJTJQ' });

    await runFor(agent, brandA);
    const row = await AttributionModel.findOne({ campaignId: shortWindow }).lean();
    expect(row?.windowHoursUsed).toBe(24);
  });

  it('does not attribute an order placed long after the code expired', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'discount_code',
      value: 'AMARA10',
      activeUntil: AUG(5),
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      orderedAt: AUG(25),
    });

    const res = await runFor(agent, brandA);
    expect(res.body.attributed).toBe(0);
    expect(res.body.byReason.outside_window).toBe(1);
  });

  it('does attribute an order just inside the grace period, and says why', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      type: 'discount_code',
      value: 'AMARA10',
      activeUntil: AUG(5),
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      orderedAt: AUG(9),
    });

    const res = await runFor(agent, brandA);
    expect(res.body.attributed).toBe(1);
    const row = await AttributionModel.findOne({}).lean();
    expect(row?.note).toContain('expired');
  });
});

/* ------------------------------------------------------- unattributed */

describe('never fabricating attribution', () => {
  it('leaves orders with no signal unattributed and reports them', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ brandId: brandA, externalOrderId: '1002' });
    await makeOrder({ brandId: brandA, externalOrderId: '1003', discountCodeKey: 'SUMMERSALE' });

    const res = await runFor(agent, brandA);
    expect(res.body.attributed).toBe(1);
    expect(res.body.unattributed).toBe(2);
    expect(res.body.byReason.no_signal).toBe(1);
    expect(res.body.byReason.code_not_recognised).toBe(1);
    // The counts must reconcile.
    expect(res.body.attributed + res.body.unattributed).toBe(res.body.total);

    const list = await agent.get(`/api/operator/brands/${brandA.toString()}/attribution/unattributed`);
    expect(list.status).toBe(200);
    expect(list.body.counts).toEqual({ orders: 3, attributed: 1, unattributed: 2 });
    expect(list.body.orders).toHaveLength(2);
    // The signal that was present is shown, so the reason is arguable.
    const withCode = list.body.orders.find(
      (o: { externalOrderId: string }) => o.externalOrderId === '1003',
    );
    expect(withCode.discountCodeUsed).toBe('SUMMERSALE');
  });

  it('never attributes a cancelled order', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      status: 'cancelled',
    });

    const res = await runFor(agent, brandA);
    expect(res.body.attributed).toBe(0);
    expect(res.body.byReason.order_cancelled).toBe(1);
  });

  it('still attributes a refunded order, because the sale did happen', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      status: 'refunded',
      refundedMinor: 12_000,
    });

    const res = await runFor(agent, brandA);
    expect(res.body.attributed).toBe(1);
  });
});

/* ------------------------------------------------------------- manual */

describe('manual assignment', () => {
  it('assigns by hand, supersedes the old row, and keeps the reason', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeAsset({ join: joinTom, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'TOM10', rateBps: 800 });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);

    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: joinTom.toString(), reason: 'Amara shared her code with Tom' });
    expect(res.status).toBe(201);
    expect(res.body.supersededId).toBeTruthy();

    const live = await AttributionModel.findOne({ orderId, supersededBy: null }).lean();
    expect(live?.method).toBe('manual_assignment');
    expect(live?.campaignCreatorId.toString()).toBe(joinTom.toString());
    expect(live?.assignedByOperatorId?.toString()).toBe(operatorId.toString());
    expect(live?.note).toBe('Amara shared her code with Tom');
    // The rate comes from Tom's own asset, not invented.
    expect(live?.rateAppliedBps).toBe(800);
  });

  it('requires a reason', async () => {
    const agent = await signedIn();
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001' });
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: joinTom.toString(), reason: '' });
    expect(res.status).toBe(400);
  });

  it('a re-run never overrules a manual assignment', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);
    await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: joinTom.toString(), reason: 'code was shared' });

    const res = await runFor(agent, brandA);
    expect(res.body.created).toBe(0);

    const live = await AttributionModel.findOne({ orderId, supersededBy: null }).lean();
    expect(live?.method).toBe('manual_assignment');
    expect(live?.campaignCreatorId.toString()).toBe(joinTom.toString());
  });

  it('refuses to assign an order to a creator on another brand', async () => {
    const agent = await signedIn();
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001' });
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: joinBrandB.toString(), reason: 'wrong tenant' });
    expect(res.status).toBe(404);
    expect(await AttributionModel.countDocuments({})).toBe(0);
  });

  it('withdraws an attribution without replacing it', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);

    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution/withdraw`)
      .send({ reason: 'the brand disputes this order' });
    expect(res.status).toBe(200);
    expect(await AttributionModel.countDocuments({ supersededBy: null })).toBe(0);

    const history = await agent.get(
      `/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution-history`,
    );
    // Superseded by itself reads back as "withdrawn", not "replaced".
    expect(history.body.history[0].withdrawn).toBe(true);
    expect(history.body.history[0].supersededReason).toContain('disputes');
  });

  it('shows the full chain in order', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);
    await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: joinTom.toString(), reason: 'first correction' });

    const res = await agent.get(
      `/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution-history`,
    );
    expect(res.body.history).toHaveLength(2);
    expect(res.body.history[0].method).toBe('code_redemption');
    expect(res.body.history[0].live).toBe(false);
    expect(res.body.history[1].method).toBe('manual_assignment');
    expect(res.body.history[1].live).toBe(true);
  });
});

/* ----------------------------------------------------------- conflicts */

describe('conflict review', () => {
  it('lists unreviewed conflicts with both creator names', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeAsset({ join: joinTom, brandId: brandA, campaignId: campaignA, type: 'tracked_link', value: 'x', shortCode: 'TVWXYZ2' });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      attributionRef: 'TVWXYZ2',
    });
    await runFor(agent, brandA);

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/attribution/conflicts`);
    expect(res.status).toBe(200);
    expect(res.body.conflicts).toHaveLength(1);
    expect(res.body.conflicts[0].winningCreatorName).toBe('amara bell');
    expect(res.body.conflicts[0].losingCreatorName).toBe('tom yilmaz');
    expect(res.body.conflicts[0].orderTotalFormatted).toContain('120');
  });

  it('marks a conflict reviewed and drops it from the default list', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeAsset({ join: joinTom, brandId: brandA, campaignId: campaignA, type: 'tracked_link', value: 'x', shortCode: 'TVWXYZ2' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', attributionRef: 'TVWXYZ2' });
    await runFor(agent, brandA);

    const list = await agent.get(`/api/operator/brands/${brandA.toString()}/attribution/conflicts`);
    const id = list.body.conflicts[0].id;

    const review = await agent
      .post(`/api/operator/brands/${brandA.toString()}/attribution/conflicts/${id}/review`)
      .send({ resolution: 'Tom reposted Amara’s code; left as is.' });
    expect(review.status).toBe(200);

    const after = await agent.get(`/api/operator/brands/${brandA.toString()}/attribution/conflicts`);
    expect(after.body.conflicts).toHaveLength(0);

    const all = await agent.get(
      `/api/operator/brands/${brandA.toString()}/attribution/conflicts?reviewed=all`,
    );
    expect(all.body.conflicts).toHaveLength(1);
    expect(all.body.conflicts[0].resolution).toContain('reposted');
  });

  it('requires a resolution', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(
        `/api/operator/brands/${brandA.toString()}/attribution/conflicts/${new Types.ObjectId().toString()}/review`,
      )
      .send({ resolution: '' });
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------ brand isolation */

describe('cross-brand isolation', () => {
  beforeEach(async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeAsset({ join: joinBrandB, brandId: brandB, campaignId: campaignB, type: 'discount_code', value: 'NIA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ brandId: brandB, externalOrderId: '9001', discountCodeKey: 'NJAJQ' });
    await runFor(agent, brandA);
    await runFor(agent, brandB);
    await clearRateLimits();
  });

  it('a run for one brand never touches the other', async () => {
    expect(await AttributionModel.countDocuments({ brandId: brandA })).toBe(1);
    expect(await AttributionModel.countDocuments({ brandId: brandB })).toBe(1);
  });

  /**
   * Two brands may both run the same code. It must never let one brand's
   * order be credited to the other brand's creator.
   */
  it('the same code under two brands stays separate', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinBrandB, brandId: brandB, campaignId: campaignB, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({ brandId: brandB, externalOrderId: '9002', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandB);

    const row = await AttributionModel.findOne({
      brandId: brandB,
      campaignCreatorId: joinBrandB,
      method: 'code_redemption',
    })
      .sort({ attributedAt: -1 })
      .lean();
    expect(row).not.toBeNull();
    expect(await AttributionModel.countDocuments({ brandId: brandB, campaignCreatorId: joinAmara })).toBe(0);
  });

  it('the attribution list never crosses brands', async () => {
    const agent = await signedIn();
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/attributions`);
    const b = await agent.get(`/api/operator/brands/${brandB.toString()}/attributions`);
    expect(a.body.attributions).toHaveLength(1);
    expect(b.body.attributions).toHaveLength(1);
    expect(a.body.attributions[0].externalOrderId).toBe('1001');
    expect(b.body.attributions[0].externalOrderId).toBe('9001');
  });

  it('the unattributed list never crosses brands', async () => {
    const agent = await signedIn();
    await makeOrder({ brandId: brandB, externalOrderId: '9003' });
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/attribution/unattributed`);
    expect(a.body.counts.orders).toBe(1);
    expect(a.body.orders).toHaveLength(0);
  });

  it('history for an order is refused under the wrong brand', async () => {
    const agent = await signedIn();
    const order = await OrderModel.findOne({ brandId: brandA }).lean();
    const res = await agent.get(
      `/api/operator/brands/${brandB.toString()}/orders/${order?._id.toString()}/attribution-history`,
    );
    expect(res.body.history).toHaveLength(0);
  });

  it('an unknown brand 404s rather than returning an empty run', async () => {
    const agent = await signedIn();
    const res = await agent.post(
      `/api/operator/brands/${new Types.ObjectId().toString()}/attribution/run`,
    );
    expect(res.status).toBe(404);
  });
});

/* ---------------------------------------------------------------- auth */

describe('authentication', () => {
  it('refuses without a session', async () => {
    const res = await request(app).post(
      `/api/operator/brands/${brandA.toString()}/attribution/run`,
    );
    expect(res.status).toBe(401);
  });

  it('audits a run with counts only', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, type: 'discount_code', value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runFor(agent, brandA);

    const entry = await AuditLogModel.findOne({ action: 'attribution.run' }).lean();
    expect(entry?.detail).toMatchObject({ considered: 1, attributed: 1, created: 1 });
    expect(JSON.stringify(entry?.detail)).not.toContain('AMARAJQ');
  });
});
