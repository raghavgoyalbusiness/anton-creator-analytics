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
  BrandModel,
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  OperatorModel,
  SessionModel,
} from '../db/models/index.js';
import { AttributionConflictModel, AttributionModel } from '../db/models/Attribution.js';
import { CommissionEntryModel, PaymentRecordModel } from '../db/models/Commission.js';
import { ColumnMappingModel, IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { LinkClickModel, TrackingAssetModel } from '../db/models/TrackingAsset.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Express;
let operatorId: Types.ObjectId;
let brandA: Types.ObjectId;
let brandB: Types.ObjectId;
let campaignA: Types.ObjectId;
let campaignB: Types.ObjectId;
let joinAmara: Types.ObjectId;
let creatorAmara: Types.ObjectId;
let joinBrandB: Types.ObjectId;
let batchId: Types.ObjectId;

const PASSWORD = 'commission-test-password';
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
    .send({ email: 'money@anton.example', password: PASSWORD, totpCode: totp() });
  if (res.status !== 200) console.error('[login failed]', res.status, res.text?.slice(0, 300));
  expect(res.status).toBe(200);
  return agent;
}

async function goStale(): Promise<void> {
  await SessionModel.updateMany(
    { subjectKind: 'operator' },
    { $set: { lastReauthAt: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
  );
}

const AUG = (day: number, hour = 12): Date => new Date(Date.UTC(2026, 7, day, hour, 0, 0));

async function makeCampaign(brandId: Types.ObjectId, name: string): Promise<Types.ObjectId> {
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
  });
  return id;
}

async function makeJoin(
  campaignId: Types.ObjectId,
  handle: string,
): Promise<{ join: Types.ObjectId; creator: Types.ObjectId }> {
  const creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: handle.replace('.', ' '),
    handles: [{ platform: 'instagram', handle }],
    status: 'active',
  });
  const join = await CampaignCreatorModel.create({ campaignId, creatorId, status: 'accepted' });
  return { join: join._id, creator: creatorId };
}

async function makeAsset(params: {
  join: Types.ObjectId;
  brandId: Types.ObjectId;
  campaignId: Types.ObjectId;
  value: string;
  rateBps?: number;
  basis?: 'order_subtotal' | 'order_total';
}): Promise<Types.ObjectId> {
  const join = await CampaignCreatorModel.findById(params.join).lean();
  const doc = await TrackingAssetModel.create({
    campaignCreatorId: params.join,
    campaignId: params.campaignId,
    creatorId: join?.creatorId,
    brandId: params.brandId,
    type: 'discount_code',
    value: params.value,
    issuedAt: AUG(1),
    activeFrom: AUG(1),
    status: 'active',
    commissionRateBps: params.rateBps ?? 1000,
    commissionRateBasis: params.basis ?? 'order_subtotal',
    issuedByOperatorId: operatorId,
  });
  return doc._id;
}

async function makeOrder(params: {
  brandId: Types.ObjectId;
  externalOrderId: string;
  totalMinor?: number;
  subtotalMinor?: number;
  discountCodeKey?: string | null;
  status?: string;
  refundedMinor?: number | null;
  currency?: string;
}): Promise<Types.ObjectId> {
  const total = params.totalMinor ?? 12_000;
  const currency = params.currency ?? 'GBP';
  const doc = await OrderModel.create({
    brandId: params.brandId,
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
    rawRow: { id: params.externalOrderId },
  });
  return doc._id;
}

const runAttrib = (agent: TestAgent, brandId: Types.ObjectId) =>
  agent.post(`/api/operator/brands/${brandId.toString()}/attribution/run`);
const post = (agent: TestAgent, brandId: Types.ObjectId) =>
  agent.post(`/api/operator/brands/${brandId.toString()}/commission/post`);

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
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    ColumnMappingModel.deleteMany({}),
    AttributionModel.deleteMany({}),
    AttributionConflictModel.deleteMany({}),
    // The model refuses deleteMany, so the ledger is cleared at the driver.
    CommissionEntryModel.collection.deleteMany({}),
    PaymentRecordModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'money@anton.example',
    displayName: 'Money Operator',
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

  const amara = await makeJoin(campaignA, 'amara.bell');
  joinAmara = amara.join;
  creatorAmara = amara.creator;
  joinBrandB = (await makeJoin(campaignB, 'nia.castellan')).join;

  const batch = await IngestBatchModel.create({
    brandId: brandA,
    source: 'manual_csv',
    status: 'committed',
    uploadedByOperatorId: operatorId,
  });
  batchId = batch._id;
});

/* -------------------------------------------------------------- append-only */

describe('the ledger is append-only', () => {
  it('refuses updateOne, findOneAndUpdate and deleteMany at the model', async () => {
    const entry = await CommissionEntryModel.create({
      creatorId: creatorAmara,
      campaignId: campaignA,
      campaignCreatorId: joinAmara,
      brandId: brandA,
      type: 'accrual',
      amount: { amountMinor: 100, currency: 'GBP' },
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 1_000, currency: 'GBP' },
      createdBy: 'test',
    });

    await expect(
      CommissionEntryModel.updateOne({ _id: entry._id }, { $set: { amount: { amountMinor: 1, currency: 'GBP' } } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      CommissionEntryModel.findOneAndUpdate({ _id: entry._id }, { $set: { reason: 'x' } }),
    ).rejects.toThrow(/append-only/);
    await expect(CommissionEntryModel.deleteMany({})).rejects.toThrow(/append-only/);
    await expect(CommissionEntryModel.deleteOne({ _id: entry._id })).rejects.toThrow(/append-only/);

    // And the row is untouched.
    const still = await CommissionEntryModel.findById(entry._id).lean();
    expect(still?.amount.amountMinor).toBe(100);
  });

  it('refuses a negative accrual and a positive reversal', async () => {
    const base = {
      creatorId: creatorAmara,
      campaignId: campaignA,
      campaignCreatorId: joinAmara,
      brandId: brandA,
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 1_000, currency: 'GBP' },
      createdBy: 'test',
    };
    await expect(
      CommissionEntryModel.create({ ...base, type: 'accrual', amount: { amountMinor: -1, currency: 'GBP' } }),
    ).rejects.toThrow(/never negative/);
    await expect(
      CommissionEntryModel.create({
        ...base,
        type: 'reversal',
        amount: { amountMinor: 1, currency: 'GBP' },
        reason: 'x',
      }),
    ).rejects.toThrow(/never positive/);
  });

  it('requires a reason on a reversal or adjustment', async () => {
    await expect(
      CommissionEntryModel.create({
        creatorId: creatorAmara,
        campaignId: campaignA,
        campaignCreatorId: joinAmara,
        brandId: brandA,
        type: 'adjustment',
        amount: { amountMinor: 500, currency: 'GBP' },
        rateAppliedBps: 0,
        rateBasis: 'order_subtotal',
        basisAmount: { amountMinor: 0, currency: 'GBP' },
        createdBy: 'test',
      }),
    ).rejects.toThrow(/must carry a reason/);
  });

  it('cannot accrue the same attribution twice', async () => {
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001' });
    const attribution = await AttributionModel.create({
      orderId,
      brandId: brandA,
      campaignId: campaignA,
      campaignCreatorId: joinAmara,
      creatorId: creatorAmara,
      method: 'manual_assignment',
      confidence: 'direct',
      attributedAt: new Date(),
      attributedValue: { amountMinor: 12_000, currency: 'GBP' },
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 12_000, currency: 'GBP' },
    });

    const entry = {
      creatorId: creatorAmara,
      campaignId: campaignA,
      campaignCreatorId: joinAmara,
      brandId: brandA,
      orderId,
      attributionId: attribution._id,
      type: 'accrual',
      amount: { amountMinor: 1_200, currency: 'GBP' },
      rateAppliedBps: 1000,
      rateBasis: 'order_subtotal',
      basisAmount: { amountMinor: 12_000, currency: 'GBP' },
      createdBy: 'test',
    };
    await CommissionEntryModel.create(entry);
    await expect(CommissionEntryModel.create(entry)).rejects.toThrow(/duplicate key/i);
  });
});

/* ----------------------------------------------------------------- accrual */

describe('posting accruals', () => {
  it('accrues commission at the attributed rate, with visible workings', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10', rateBps: 1250 });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 12_000,
      subtotalMinor: 10_000,
    });
    await runAttrib(agent, brandA);

    const res = await post(agent, brandA);
    expect(res.status).toBe(200);
    expect(res.body.accrualsCreated).toBe(1);

    const entry = await CommissionEntryModel.findOne({ brandId: brandA }).lean();
    // 12.5% of the 10000 subtotal.
    expect(entry?.amount.amountMinor).toBe(1_250);
    expect(entry?.type).toBe('accrual');
    expect(entry?.workings).toContain('12.5%');
    expect(entry?.workings).toContain('10000');
  });

  it('applies the rate to the total when that is the basis', async () => {
    const agent = await signedIn();
    await makeAsset({
      join: joinAmara,
      brandId: brandA,
      campaignId: campaignA,
      value: 'AMARA10',
      rateBps: 1000,
      basis: 'order_total',
    });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 12_000,
      subtotalMinor: 10_000,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const entry = await CommissionEntryModel.findOne({ brandId: brandA }).lean();
    expect(entry?.amount.amountMinor).toBe(1_200);
  });

  /** The guarantee the whole module rests on. */
  it('posting twice produces identical entries and identical balances', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ brandId: brandA, externalOrderId: '1002', discountCodeKey: 'AMARAJQ', totalMinor: 5_000 });
    await runAttrib(agent, brandA);

    const first = await post(agent, brandA);
    const afterFirst = await CommissionEntryModel.find({ brandId: brandA }).lean();
    const totalFirst = afterFirst.reduce((n, e) => n + e.amount.amountMinor, 0);

    const second = await post(agent, brandA);
    const afterSecond = await CommissionEntryModel.find({ brandId: brandA }).lean();
    const totalSecond = afterSecond.reduce((n, e) => n + e.amount.amountMinor, 0);

    expect(first.body.accrualsCreated).toBe(2);
    expect(second.body.accrualsCreated).toBe(0);
    expect(second.body.accrualsSkipped).toBe(2);
    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(totalSecond).toBe(totalFirst);
    expect(totalSecond).toBe(1_200 + 500);
  });

  it('accrues nothing for an unattributed order', async () => {
    const agent = await signedIn();
    await makeOrder({ brandId: brandA, externalOrderId: '1001' });
    await runAttrib(agent, brandA);
    const res = await post(agent, brandA);
    expect(res.body.accrualsCreated).toBe(0);
    expect(await CommissionEntryModel.countDocuments({})).toBe(0);
  });
});

/* --------------------------------------------------------------- reversals */

describe('refund reversals', () => {
  it('reverses a full refund by exact negation, leaving a zero balance', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10', rateBps: 1234 });
    const orderId = await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 9_999,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const accrual = await CommissionEntryModel.findOne({ type: 'accrual' }).lean();
    expect(accrual?.amount.amountMinor).toBe(1_234); // 12.34% of 9999 = 1233.8766 → 1234

    // The refund arrives in a later upload.
    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'refunded', refundedAmount: { amountMinor: 9_999, currency: 'GBP' }, refundedAt: AUG(20) } },
    );
    const res = await post(agent, brandA);
    expect(res.body.reversalsCreated).toBe(1);

    const entries = await CommissionEntryModel.find({ brandId: brandA }).lean();
    const balance = entries.reduce((n, e) => n + e.amount.amountMinor, 0);
    // Exact negation, not a recalculation — a fully refunded order must return
    // the ledger to zero with no stranded penny.
    expect(balance).toBe(0);
    const reversal = entries.find((e) => e.type === 'reversal');
    expect(reversal?.amount.amountMinor).toBe(-1_234);
    expect(reversal?.reason).toContain('refunded');
  });

  it('prorates a partial refund', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10', rateBps: 1000 });
    const orderId = await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'partially_refunded', refundedAmount: { amountMinor: 2_500, currency: 'GBP' } } },
    );
    await post(agent, brandA);

    const entries = await CommissionEntryModel.find({ brandId: brandA }).lean();
    const balance = entries.reduce((n, e) => n + e.amount.amountMinor, 0);
    // A quarter of the order came back, so a quarter of the 1000 commission does.
    expect(balance).toBe(750);
  });

  /** Re-ingesting the same refund must not claw back twice. */
  it('re-posting an already-reversed refund is a no-op', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runAttrib(agent, brandA);
    await post(agent, brandA);
    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'refunded', refundedAmount: { amountMinor: 12_000, currency: 'GBP' } } },
    );
    await post(agent, brandA);

    const third = await post(agent, brandA);
    expect(third.body.reversalsCreated).toBe(0);
    expect(third.body.reversalsUnchanged).toBe(1);
    expect(await CommissionEntryModel.countDocuments({ type: 'reversal' })).toBe(1);
  });

  it('tops up a reversal when a partial refund grows', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    const orderId = await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'partially_refunded', refundedAmount: { amountMinor: 2_000, currency: 'GBP' } } },
    );
    await post(agent, brandA);

    // A second refund on the same order takes it to the full amount.
    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'refunded', refundedAmount: { amountMinor: 10_000, currency: 'GBP' } } },
    );
    await post(agent, brandA);

    const entries = await CommissionEntryModel.find({ brandId: brandA }).lean();
    expect(entries.filter((e) => e.type === 'reversal')).toHaveLength(2);
    // The parts sum back to the whole: nothing owed, nothing stranded.
    expect(entries.reduce((n, e) => n + e.amount.amountMinor, 0)).toBe(0);
  });

  it('reverses in full when an accrued order is later cancelled', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    await OrderModel.updateOne({ _id: orderId }, { $set: { status: 'cancelled' } });
    await post(agent, brandA);

    const entries = await CommissionEntryModel.find({ brandId: brandA }).lean();
    expect(entries.reduce((n, e) => n + e.amount.amountMinor, 0)).toBe(0);
    expect(entries.find((e) => e.type === 'reversal')?.reason).toContain('cancelled');
  });

  /**
   * The accrual cannot be deleted, so a withdrawn attribution has to be
   * reversed. Doing nothing would leave a creator owed for an order somebody
   * decided was not theirs.
   */
  it('reverses an accrual whose attribution is withdrawn', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    const orderId = await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runAttrib(agent, brandA);
    await post(agent, brandA);
    expect(await CommissionEntryModel.countDocuments({})).toBe(1);

    await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution/withdraw`)
      .send({ reason: 'the brand disputes this order' });

    const res = await post(agent, brandA);
    expect(res.body.orphanedReversals).toBe(1);

    const entries = await CommissionEntryModel.find({ brandId: brandA }).lean();
    expect(entries.reduce((n, e) => n + e.amount.amountMinor, 0)).toBe(0);
    expect(entries.find((e) => e.type === 'reversal')?.reason).toContain('withdrawn');

    // And it does not keep reversing on every subsequent run.
    const again = await post(agent, brandA);
    expect(again.body.orphanedReversals).toBe(0);
  });

  it('moves the money when an order is reassigned by hand', async () => {
    const agent = await signedIn();
    const tom = await makeJoin(campaignA, 'tom.yilmaz');
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10', rateBps: 1000 });
    await makeAsset({ join: tom.join, brandId: brandA, campaignId: campaignA, value: 'TOM10', rateBps: 500 });
    const orderId = await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/${orderId.toString()}/attribution`)
      .send({ campaignCreatorId: tom.join.toString(), reason: 'Amara shared her code' });
    await post(agent, brandA);

    const amaraEntries = await CommissionEntryModel.find({ creatorId: creatorAmara }).lean();
    const tomEntries = await CommissionEntryModel.find({ creatorId: tom.creator }).lean();

    // Amara's accrual is reversed, not deleted; Tom accrues at his own rate.
    expect(amaraEntries.reduce((n, e) => n + e.amount.amountMinor, 0)).toBe(0);
    expect(amaraEntries).toHaveLength(2);
    expect(tomEntries.reduce((n, e) => n + e.amount.amountMinor, 0)).toBe(500);
  });
});

/* ------------------------------------------------------------- balances */

describe('balances', () => {
  it('sums the ledger and shows earned, paid and outstanding', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 400, currency: 'GBP' },
      paidAt: AUG(20).toISOString(),
      method: 'bank transfer',
      reference: 'INV-1',
    });

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/balances`);
    expect(res.status).toBe(200);
    expect(res.body.balances).toHaveLength(1);
    expect(res.body.balances[0].earned.amountMinor).toBe(1_000);
    expect(res.body.balances[0].paid.amountMinor).toBe(400);
    expect(res.body.balances[0].outstanding.amountMinor).toBe(600);
    expect(res.body.balances[0].outstandingFormatted).toContain('6');
  });

  /**
   * Mixing currencies into one number needs an exchange rate Anton does not
   * have. The figure is null with a stated reason, never a guess.
   */
  it('refuses a single total when a creator earns in two currencies', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1002',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
      currency: 'EUR',
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/balances`);
    const row = res.body.balances[0];
    expect(row.outstanding).toBeNull();
    expect(row.unavailableReason).toContain('more than one currency');
    expect(row.breakdown).toHaveLength(2);
    expect(row.breakdown.map((b: { currency: string }) => b.currency)).toEqual(['EUR', 'GBP']);
  });

  it('gives a creator a statement with a running balance on every line', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    const orderId = await makeOrder({
      brandId: brandA,
      externalOrderId: '1001',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 10_000,
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);
    await OrderModel.updateOne(
      { _id: orderId },
      { $set: { status: 'partially_refunded', refundedAmount: { amountMinor: 5_000, currency: 'GBP' } } },
    );
    await post(agent, brandA);

    const res = await agent.get(
      `/api/operator/brands/${brandA.toString()}/creators/${creatorAmara.toString()}/ledger`,
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0].balanceAfter.amountMinor).toBe(1_000);
    expect(res.body.entries[1].balanceAfter.amountMinor).toBe(500);
    expect(res.body.earnings.balance.total.amountMinor).toBe(500);
    // Every line shows how it was reached.
    expect(res.body.entries[0].workings).toBeTruthy();
    expect(res.body.entries[0].externalOrderId).toBe('1001');
  });

  it('a multi-currency statement still renders, per currency', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await makeOrder({
      brandId: brandA,
      externalOrderId: '1002',
      discountCodeKey: 'AMARAJQ',
      totalMinor: 20_000,
      currency: 'EUR',
    });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const res = await agent.get(
      `/api/operator/brands/${brandA.toString()}/creators/${creatorAmara.toString()}/ledger`,
    );
    expect(res.status).toBe(200);
    expect(res.body.earnings.balance.total).toBeNull();
    expect(res.body.earnings.balance.byCurrency).toHaveLength(2);
    // Each line still carries a balance, computed within its own currency.
    for (const e of res.body.entries) expect(e.balanceAfter).not.toBeNull();
  });
});

/* ------------------------------------------------------------ adjustments */

describe('adjustments and payments', () => {
  it('records an adjustment as a new entry with a reason', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`)
      .send({
        campaignCreatorId: joinAmara.toString(),
        amount: { amountMinor: 2_500, currency: 'GBP' },
        reason: 'Goodwill for the delayed brief.',
      });
    expect(res.status).toBe(201);

    const entry = await CommissionEntryModel.findOne({ type: 'adjustment' }).lean();
    expect(entry?.amount.amountMinor).toBe(2_500);
    expect(entry?.reason).toContain('Goodwill');
    expect(entry?.createdByOperatorId?.toString()).toBe(operatorId.toString());
  });

  it('allows a negative adjustment but not a zero one', async () => {
    const agent = await signedIn();
    const negative = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`)
      .send({
        campaignCreatorId: joinAmara.toString(),
        amount: { amountMinor: -500, currency: 'GBP' },
        reason: 'Correcting an overpayment.',
      });
    expect(negative.status).toBe(201);

    const zero = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`)
      .send({
        campaignCreatorId: joinAmara.toString(),
        amount: { amountMinor: 0, currency: 'GBP' },
        reason: 'nothing',
      });
    expect(zero.status).toBe(400);
  });

  it('requires a reason on an adjustment', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`)
      .send({
        campaignCreatorId: joinAmara.toString(),
        amount: { amountMinor: 100, currency: 'GBP' },
        reason: '',
      });
    expect(res.status).toBe(400);
  });

  it('refuses a payment dated in the future', async () => {
    const agent = await signedIn();
    const res = await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 100, currency: 'GBP' },
      paidAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('future_payment');
  });

  it('refuses a payment of zero or less', async () => {
    const agent = await signedIn();
    const res = await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 0, currency: 'GBP' },
      paidAt: AUG(10).toISOString(),
    });
    expect(res.status).toBe(400);
  });

  it('voids a payment record without deleting it', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const created = await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 900, currency: 'GBP' },
      paidAt: AUG(10).toISOString(),
    });

    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/payments/${created.body.paymentId}/void`)
      .send({ reason: 'the transfer bounced' });
    expect(res.status).toBe(200);

    // The claim survives as evidence that it was made.
    const row = await PaymentRecordModel.findById(created.body.paymentId).lean();
    expect(row).not.toBeNull();
    expect(row?.voidedAt).not.toBeNull();
    expect(row?.voidedReason).toBe('the transfer bounced');

    // And a voided payment no longer counts against what is owed.
    const balances = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/balances`);
    const row2 = balances.body.balances.find(
      (b: { creatorId: string }) => b.creatorId === creatorAmara.toString(),
    );
    expect(row2.paid.amountMinor).toBe(0);
    expect(row2.outstanding.amountMinor).toBe(1_000);
  });

  it('will not void the same payment twice', async () => {
    const agent = await signedIn();
    const created = await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 900, currency: 'GBP' },
      paidAt: AUG(10).toISOString(),
    });
    const path = `/api/operator/brands/${brandA.toString()}/commission/payments/${created.body.paymentId}/void`;
    expect((await agent.post(path).send({ reason: 'x' })).status).toBe(200);
    expect((await agent.post(path).send({ reason: 'x' })).status).toBe(404);
  });
});

/* --------------------------------------------------------- reconciliation */

describe('reconciliation against CampaignCreator.status', () => {
  it('flags a participation marked paid with no payment recorded', async () => {
    const agent = await signedIn();
    await CampaignCreatorModel.updateOne({ _id: joinAmara }, { $set: { status: 'paid' } });

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/reconciliation`);
    expect(res.status).toBe(200);
    const problem = res.body.disagreements.find(
      (d: { campaignCreatorId: string }) => d.campaignCreatorId === joinAmara.toString(),
    );
    expect(problem.problem).toBe('marked_paid_without_record');
  });

  it('flags a participation marked paid that is still owed money', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runAttrib(agent, brandA);
    await post(agent, brandA);
    await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 400, currency: 'GBP' },
      paidAt: AUG(20).toISOString(),
    });
    await CampaignCreatorModel.updateOne({ _id: joinAmara }, { $set: { status: 'paid' } });

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/reconciliation`);
    const problem = res.body.disagreements.find(
      (d: { campaignCreatorId: string }) => d.campaignCreatorId === joinAmara.toString(),
    );
    expect(problem.problem).toBe('marked_paid_but_owed');
    expect(problem.outstandingMinor).toBe(600);
  });

  it('flags a settled participation that nobody marked paid', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ', totalMinor: 10_000 });
    await runAttrib(agent, brandA);
    await post(agent, brandA);
    await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 1_000, currency: 'GBP' },
      paidAt: AUG(20).toISOString(),
    });

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/reconciliation`);
    const problem = res.body.disagreements.find(
      (d: { campaignCreatorId: string }) => d.campaignCreatorId === joinAmara.toString(),
    );
    expect(problem.problem).toBe('settled_but_not_marked');
  });

  it('says nothing when the two agree', async () => {
    const agent = await signedIn();
    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/reconciliation`);
    expect(res.body.disagreements).toHaveLength(0);
    expect(res.body.checked).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------- isolation */

describe('cross-brand isolation', () => {
  beforeEach(async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeAsset({ join: joinBrandB, brandId: brandB, campaignId: campaignB, value: 'NIA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await makeOrder({ brandId: brandB, externalOrderId: '9001', discountCodeKey: 'NJAJQ', totalMinor: 50_000 });
    await runAttrib(agent, brandA);
    await runAttrib(agent, brandB);
    await post(agent, brandA);
    await post(agent, brandB);
    await clearRateLimits();
  });

  it('balances never cross brands', async () => {
    const agent = await signedIn();
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/balances`);
    const b = await agent.get(`/api/operator/brands/${brandB.toString()}/commission/balances`);
    expect(a.body.balances).toHaveLength(1);
    expect(b.body.balances).toHaveLength(1);
    expect(a.body.balances[0].earned.amountMinor).toBe(1_200);
    expect(b.body.balances[0].earned.amountMinor).toBe(5_000);
  });

  it('a creator ledger under the wrong brand is empty, not another brand’s', async () => {
    const agent = await signedIn();
    const res = await agent.get(
      `/api/operator/brands/${brandB.toString()}/creators/${creatorAmara.toString()}/ledger`,
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
    expect(res.body.earnings.balance.total).toBeNull();
  });

  it('refuses an adjustment against another brand’s participation', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`)
      .send({
        campaignCreatorId: joinBrandB.toString(),
        amount: { amountMinor: 5_000, currency: 'GBP' },
        reason: 'wrong tenant',
      });
    expect(res.status).toBe(404);
  });

  it('refuses a payment against another brand’s participation', async () => {
    const agent = await signedIn();
    const res = await agent.post(`/api/operator/brands/${brandA.toString()}/commission/payments`).send({
      campaignCreatorId: joinBrandB.toString(),
      amount: { amountMinor: 100, currency: 'GBP' },
      paidAt: AUG(10).toISOString(),
    });
    expect(res.status).toBe(404);
  });

  it('the export never crosses brands', async () => {
    const agent = await signedIn();
    const res = await agent.get(`/api/operator/brands/${brandB.toString()}/commission/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('nia castellan');
    expect(res.text).not.toContain('amara bell');
  });
});

/* ------------------------------------------------------------- the export */

describe('export', () => {
  it('requires a fresh password check', async () => {
    const agent = await signedIn();
    await goStale();
    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/export`);
    expect(res.status).toBe(403);
  });

  /**
   * A creator's display name is user-supplied text. One beginning with `=`
   * becomes an executable formula the moment the finance team opens this.
   */
  it('neutralises formula injection in a creator name', async () => {
    const agent = await signedIn();
    await CreatorModel.updateOne(
      { _id: creatorAmara },
      { $set: { displayName: '=HYPERLINK("http://evil.test","claim")' } },
    );
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("'=HYPERLINK");
    for (const line of res.text.trim().split('\n')) {
      for (const cell of line.split(',')) {
        expect(['=', '+', '@']).not.toContain(cell.replace(/^"/, '')[0] ?? '');
      }
    }
  });

  it('carries the workings so every figure can be checked', async () => {
    const agent = await signedIn();
    await makeAsset({ join: joinAmara, brandId: brandA, campaignId: campaignA, value: 'AMARA10' });
    await makeOrder({ brandId: brandA, externalOrderId: '1001', discountCodeKey: 'AMARAJQ' });
    await runAttrib(agent, brandA);
    await post(agent, brandA);

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/commission/export`);
    expect(res.text.split('\n')[0]).toContain('workings');
    expect(res.text).toContain('10%');
  });
});

/* ---------------------------------------------------------------- auth */

describe('authentication', () => {
  it('refuses without a session', async () => {
    const res = await request(app).post(`/api/operator/brands/${brandA.toString()}/commission/post`);
    expect(res.status).toBe(401);
  });

  it('audits an adjustment with the amount and reason', async () => {
    const agent = await signedIn();
    await agent.post(`/api/operator/brands/${brandA.toString()}/commission/adjustments`).send({
      campaignCreatorId: joinAmara.toString(),
      amount: { amountMinor: 2_500, currency: 'GBP' },
      reason: 'Goodwill.',
    });
    const entry = await AuditLogModel.findOne({ action: 'commission.adjusted' }).lean();
    expect(entry?.detail).toMatchObject({ amountMinor: 2_500, currency: 'GBP', reason: 'Goodwill.' });
  });
});
