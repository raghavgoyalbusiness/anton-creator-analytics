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
  OperatorModel,
  SessionModel,
} from '../db/models/index.js';
import { ColumnMappingModel, IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { hashPassword } from '../lib/operator-session.js';
import { clearRateLimits } from '../lib/rate-limit.js';

let app: Express;
let operatorId: Types.ObjectId;
let brandA: Types.ObjectId;
let brandB: Types.ObjectId;

const PASSWORD = 'ingest-test-password';
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
    .send({ email: 'ingest@anton.example', password: PASSWORD, totpCode: code() });
  if (res.status !== 200) {
    console.error('[login failed]', res.status, JSON.stringify(res.headers), res.text?.slice(0, 400));
  }
  expect(res.status).toBe(200);
  return agent;
}

/**
 * The export route and rollback both sit behind a fresh password check.
 *
 * Signing in is itself one, so the helper below is only needed after a session
 * has been aged past the re-auth window.
 */
async function reauth(agent: TestAgent): Promise<void> {
  const res = await agent.post('/api/operator/auth/reauth').send({ password: PASSWORD });
  expect(res.status).toBe(200);
}

/** Makes the open session look like one that has been sitting there all day. */
async function goStale(): Promise<void> {
  await SessionModel.updateMany(
    { subjectKind: 'operator' },
    { $set: { lastReauthAt: new Date(Date.now() - 6 * 60 * 60 * 1000) } },
  );
}

const MAPPING = {
  externalOrderId: 'Order ID',
  orderedAt: 'Date',
  total: 'Total',
  subtotal: 'Subtotal',
  currency: 'Currency',
  discountCode: 'Discount Code',
  customerType: 'Customer Type',
  status: 'Status',
  refundedAmount: 'Refunded',
  refundedAt: 'Refunded At',
  attributionRef: 'Landing Site',
  fallbackCurrency: 'GBP',
};

async function saveMapping(agent: TestAgent, brandId: Types.ObjectId): Promise<void> {
  const res = await agent
    .put(`/api/operator/brands/${brandId.toString()}/column-mapping`)
    .send(MAPPING);
  // The body rides along in the message: a bare status code tells you nothing
  // when this fails inside a helper.
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

const HEADER =
  'Order ID,Date,Total,Subtotal,Currency,Discount Code,Customer Type,Status,Refunded,Refunded At,Landing Site';

function csv(...rows: string[]): string {
  return `${HEADER}\n${rows.join('\n')}\n`;
}

/** Three clean orders, one of them on a creator's code. */
const BASE_CSV = csv(
  '1001,2026-08-04,120.00,100.00,GBP,AMARA10,new,paid,,,',
  '1002,2026-08-05,60.50,60.50,GBP,AMARA10,returning,paid,,,',
  '1003,2026-08-06,45.00,45.00,GBP,,new,paid,,,',
);

function post(agent: TestAgent, path: string, body: string | Buffer) {
  return agent.post(path).set('content-type', 'text/csv').send(body as never);
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
    OrderModel.deleteMany({}),
    IngestBatchModel.deleteMany({}),
    ColumnMappingModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'ingest@anton.example',
    displayName: 'Ingest Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  brandA = new Types.ObjectId();
  brandB = new Types.ObjectId();
  await BrandModel.create({ _id: brandA, name: 'Brand A', defaultCurrency: 'GBP' });
  await BrandModel.create({ _id: brandB, name: 'Brand B', defaultCurrency: 'GBP' });
});

/* ------------------------------------------------------------------ auth */

describe('authentication', () => {
  it('refuses every ingest route without a session', async () => {
    const paths: [string, string][] = [
      ['get', `/api/operator/brands/${brandA.toString()}/column-mapping`],
      ['get', `/api/operator/brands/${brandA.toString()}/orders`],
      ['get', `/api/operator/brands/${brandA.toString()}/ingest-batches`],
    ];
    for (const [method, path] of paths) {
      const res = await (method === 'get' ? request(app).get(path) : request(app).post(path));
      expect(res.status).toBe(401);
    }
  });
});

/* --------------------------------------------------------------- mapping */

describe('column mapping', () => {
  it('is null until saved, then round-trips', async () => {
    const agent = await signedIn();
    const before = await agent.get(`/api/operator/brands/${brandA.toString()}/column-mapping`);
    expect(before.status).toBe(200);
    expect(before.body.mapping).toBeNull();

    await saveMapping(agent, brandA);

    const after = await agent.get(`/api/operator/brands/${brandA.toString()}/column-mapping`);
    expect(after.body.mapping.externalOrderId).toBe('Order ID');
    expect(after.body.mapping.fallbackCurrency).toBe('GBP');
  });

  it('saving twice updates rather than duplicating', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await agent
      .put(`/api/operator/brands/${brandA.toString()}/column-mapping`)
      .send({ ...MAPPING, total: 'Grand Total' });

    expect(await ColumnMappingModel.countDocuments({ brandId: brandA })).toBe(1);
    const doc = await ColumnMappingModel.findOne({ brandId: brandA }).lean();
    expect((doc?.mapping as { total: string }).total).toBe('Grand Total');
  });

  it('guesses a mapping from a header row', async () => {
    const agent = await signedIn();
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/column-mapping/guess`)
      .send({ headerRow: HEADER });
    expect(res.status).toBe(200);
    expect(res.body.headers).toContain('Order ID');
    expect(res.body.guess.externalOrderId).toBe('Order ID');
    expect(res.body.guess.total).toBe('Total');
  });

  it('rejects a mapping missing a required column', async () => {
    const agent = await signedIn();
    const res = await agent
      .put(`/api/operator/brands/${brandA.toString()}/column-mapping`)
      .send({ ...MAPPING, externalOrderId: '' });
    expect(res.status).toBe(400);
  });
});

/* --------------------------------------------------------------- preview */

describe('preview', () => {
  it('asks for a mapping before it will parse anything', async () => {
    const agent = await signedIn();
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      BASE_CSV,
    );
    expect(res.status).toBe(200);
    expect(res.body.needsMapping).toBe(true);
    expect(res.body.guess.externalOrderId).toBe('Order ID');
  });

  it('writes nothing', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      BASE_CSV,
    );
    expect(res.status).toBe(200);
    expect(res.body.validation.rowsParsed).toBe(3);
    expect(res.body.validation.wouldInsert).toBe(3);
    expect(await OrderModel.countDocuments({})).toBe(0);
    expect(await IngestBatchModel.countDocuments({})).toBe(0);
  });

  it('never returns the raw row', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      BASE_CSV,
    );
    expect(res.body.preview).toHaveLength(3);
    for (const row of res.body.preview) expect(row).not.toHaveProperty('rawRow');
    expect(JSON.stringify(res.body)).not.toContain('rawRow');
  });

  it('reports skipped rows with a reason and a line number', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const bad = csv(
      '1001,2026-08-04,120.00,100.00,GBP,,new,paid,,,',
      ',2026-08-05,60.00,60.00,GBP,,new,paid,,,',
      '1003,not-a-date,45.00,45.00,GBP,,new,paid,,,',
    );
    const res = await post(agent, `/api/operator/brands/${brandA.toString()}/orders/preview`, bad);
    expect(res.body.validation.rowsParsed).toBe(1);
    expect(res.body.validation.rowsSkipped).toBe(2);
    expect(res.body.validation.skipped[0].line).toBe(3);
    expect(res.body.validation.skipped[0].reason).toContain('order id');
    expect(res.body.validation.skipped[1].line).toBe(4);
  });

  it('recognises a byte-identical file that was already committed', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      BASE_CSV,
    );
    expect(res.body.identicalBatch).not.toBeNull();
    expect(res.body.validation.alreadyPresent).toBe(3);
    expect(res.body.validation.wouldInsert).toBe(0);
  });
});

/* ------------------------------------------------------- upload hardening */

describe('upload hardening', () => {
  it('rejects a renamed xlsx workbook', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    // PK\x03\x04 — a ZIP, which is what an .xlsx actually is.
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('rest')]);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      zip,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_a_csv');
    expect(res.body.error.message).toContain('.xlsx');
  });

  it('rejects a PNG', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('data')]);
    const res = await post(agent, `/api/operator/brands/${brandA.toString()}/orders/preview`, png);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_a_csv');
  });

  it('rejects a file carrying NUL bytes', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const binary = Buffer.concat([Buffer.from('Order ID,Date\n'), Buffer.from([0x00, 0x01, 0x02])]);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      binary,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_a_csv');
  });

  it('rejects an empty upload', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const res = await agent
      .post(`/api/operator/brands/${brandA.toString()}/orders/preview`)
      .set('content-type', 'text/csv')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('empty_upload');
  });

  it('rejects a file that is not valid UTF-8', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    // A lone 0xFF is invalid UTF-8 and decodes to a replacement character.
    const latin = Buffer.concat([Buffer.from(`${HEADER}\n1001,`), Buffer.from([0xff])]);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/preview`,
      latin,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_utf8');
  });

  it('rate limits preview uploads', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    let limited = false;
    for (let i = 0; i < 62; i += 1) {
      const res = await post(
        agent,
        `/api/operator/brands/${brandA.toString()}/orders/preview`,
        BASE_CSV,
      );
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

/* ---------------------------------------------------------- idempotency */

describe('commit', () => {
  it('refuses without a saved mapping', async () => {
    const agent = await signedIn();
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('no_mapping');
  });

  it('inserts the file', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    expect(res.status).toBe(201);
    expect(res.body.rowsInserted).toBe(3);
    expect(res.body.rowsUpdated).toBe(0);
    expect(await OrderModel.countDocuments({ brandId: brandA })).toBe(3);
  });

  /**
   * The guarantee the whole module exists for. A duplicated order double-pays
   * a creator, so this is the test that matters most in the file.
   */
  it('is idempotent: the same CSV twice gives identical row count and totals', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);

    const first = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    const afterFirst = await OrderModel.find({ brandId: brandA }).sort({ externalOrderId: 1 }).lean();
    const totalFirst = afterFirst.reduce((n, o) => n + o.total.amountMinor, 0);

    const second = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    const afterSecond = await OrderModel.find({ brandId: brandA }).sort({ externalOrderId: 1 }).lean();
    const totalSecond = afterSecond.reduce((n, o) => n + o.total.amountMinor, 0);

    expect(first.body.rowsInserted).toBe(3);
    expect(second.body.rowsInserted).toBe(0);
    expect(second.body.rowsUpdated).toBe(3);

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(totalSecond).toBe(totalFirst);
    expect(afterSecond.map((o) => o.externalOrderId)).toEqual(
      afterFirst.map((o) => o.externalOrderId),
    );
    // No refund state moved, so nothing for attribution to reverse.
    expect(second.body.changedOrderIds).toEqual([]);
  });

  it('keeps the last of a duplicated id within one file and reports it', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const dupes = csv(
      '1001,2026-08-04,120.00,100.00,GBP,,new,paid,,,',
      '1001,2026-08-04,150.00,150.00,GBP,,new,paid,,,',
    );
    const res = await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, dupes);
    expect(res.body.rowsInserted).toBe(1);
    expect(res.body.duplicatesInFile).toBe(1);
    const order = await OrderModel.findOne({ brandId: brandA, externalOrderId: '1001' }).lean();
    expect(order?.total.amountMinor).toBe(15_000);
  });

  /**
   * The case step 4 depends on: the refund is not in the file that created the
   * order, it turns up weeks later.
   */
  it('flags an order whose refund arrives in a later batch', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    const later = csv(
      '1001,2026-08-04,120.00,100.00,GBP,AMARA10,new,refunded,120.00,2026-08-20,',
      '1002,2026-08-05,60.50,60.50,GBP,AMARA10,returning,paid,,,',
      '1003,2026-08-06,45.00,45.00,GBP,,new,paid,,,',
    );
    const res = await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, later);

    expect(res.body.rowsInserted).toBe(0);
    expect(res.body.rowsUpdated).toBe(3);
    expect(res.body.changedOrderIds).toEqual(['1001']);

    const refunded = await OrderModel.findOne({ brandId: brandA, externalOrderId: '1001' }).lean();
    expect(refunded?.status).toBe('refunded');
    expect(refunded?.refundedAmount?.amountMinor).toBe(12_000);
    // Two batches have now touched it, oldest first.
    expect(refunded?.ingestHistory).toHaveLength(2);
  });

  it('flags a partial refund too', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    const partial = csv('1002,2026-08-05,60.50,60.50,GBP,AMARA10,returning,paid,20.00,2026-08-21,');
    const res = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      partial,
    );
    expect(res.body.changedOrderIds).toEqual(['1002']);
    const order = await OrderModel.findOne({ brandId: brandA, externalOrderId: '1002' }).lean();
    // The amount is load-bearing: status is derived from it, not trusted.
    expect(order?.status).toBe('partially_refunded');
    expect(order?.refundedAmount?.amountMinor).toBe(2_000);
  });

  it('stores the folded discount code alongside the verbatim one', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const mixed = csv('1001,2026-08-04,120.00,100.00,GBP,amara1o,new,paid,,,');
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, mixed);
    const order = await OrderModel.findOne({ brandId: brandA }).lean();
    expect(order?.discountCodeUsed).toBe('amara1o');
    // The ambiguous pairs collapse: O and 0 both land on Q, 1/I/L on J. So a
    // code typed "AMARA10" joins the same order as one typed "amara1o".
    expect(order?.discountCodeKey).toBe('AMARAJQ');
    expect(order?.discountCodeKey).toBe(normaliseTypedCode('AMARA10'));
  });

  it('refuses a file where nothing parsed', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const junk = csv(',,,,,,,,,,', ',,,,,,,,,,');
    const res = await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, junk);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('nothing_to_commit');
    expect(await IngestBatchModel.countDocuments({})).toBe(0);
  });

  it('records an audit entry carrying counts and no rows', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    const entry = await AuditLogModel.findOne({ action: 'orders.ingested' }).lean();
    expect(entry).not.toBeNull();
    expect(entry?.detail).toMatchObject({ inserted: 3, updated: 0 });
    // The customer's order rows must not be in the audit log.
    expect(JSON.stringify(entry?.detail)).not.toContain('AMARA10');
  });
});

/* --------------------------------------------------------------- batches */

describe('batches and rollback', () => {
  it('lists batches for the brand', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/ingest-batches`);
    expect(res.status).toBe(200);
    expect(res.body.batches).toHaveLength(1);
    expect(res.body.batches[0].status).toBe('committed');
    expect(res.body.batches[0].rowsInserted).toBe(3);
    expect(res.body.batches[0].currencies).toEqual(['GBP']);
  });

  it('requires a fresh password check to roll back', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const commit = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    await goStale();
    const res = await agent.post(
      `/api/operator/brands/${brandA.toString()}/ingest-batches/${commit.body.batchId}/rollback`,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');
    expect(await OrderModel.countDocuments({ brandId: brandA })).toBe(3);
  });

  it('deletes only the orders the batch inserted', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);

    // A second batch that updates 1001 and inserts 1004.
    const second = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      csv(
        '1001,2026-08-04,120.00,100.00,GBP,AMARA10,new,refunded,120.00,2026-08-20,',
        '1004,2026-08-09,15.00,15.00,GBP,,new,paid,,,',
      ),
    );

    await reauth(agent);
    const res = await agent.post(
      `/api/operator/brands/${brandA.toString()}/ingest-batches/${second.body.batchId}/rollback`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ordersDeleted).toBe(1);
    expect(res.body.ordersLeftAlone).toBe(1);

    // 1004 is gone; 1001 stays, refunded — reverting it would invent a state
    // no upload ever asserted.
    expect(await OrderModel.countDocuments({ brandId: brandA, externalOrderId: '1004' })).toBe(0);
    const kept = await OrderModel.findOne({ brandId: brandA, externalOrderId: '1001' }).lean();
    expect(kept?.status).toBe('refunded');
  });

  it('will not roll the same batch back twice', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const commit = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    await reauth(agent);
    const path = `/api/operator/brands/${brandA.toString()}/ingest-batches/${commit.body.batchId}/rollback`;
    expect((await agent.post(path)).status).toBe(200);
    const again = await agent.post(path);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('not_committed');
  });

  it('cannot roll back another brand’s batch', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const commit = await post(
      agent,
      `/api/operator/brands/${brandA.toString()}/orders/commit`,
      BASE_CSV,
    );
    await reauth(agent);
    const res = await agent.post(
      `/api/operator/brands/${brandB.toString()}/ingest-batches/${commit.body.batchId}/rollback`,
    );
    expect(res.status).toBe(404);
    expect(await OrderModel.countDocuments({ brandId: brandA })).toBe(3);
  });
});

/* ------------------------------------------------------- brand isolation */

describe('cross-brand isolation', () => {
  beforeEach(async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await saveMapping(agent, brandB);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);
    await post(
      agent,
      `/api/operator/brands/${brandB.toString()}/orders/commit`,
      csv('9001,2026-08-04,999.00,999.00,GBP,BRANDB,new,paid,,,'),
    );
    await clearRateLimits();
  });

  it('the order list never crosses brands', async () => {
    const agent = await signedIn();
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/orders`);
    expect(a.body.orders.map((o: { externalOrderId: string }) => o.externalOrderId).sort()).toEqual([
      '1001',
      '1002',
      '1003',
    ]);

    const b = await agent.get(`/api/operator/brands/${brandB.toString()}/orders`);
    expect(b.body.orders).toHaveLength(1);
    expect(b.body.orders[0].externalOrderId).toBe('9001');
  });

  /** The brand id comes from the route, so a forged query cannot widen it. */
  it('ignores a brand id smuggled through the query string', async () => {
    const agent = await signedIn();
    const res = await agent.get(
      `/api/operator/brands/${brandB.toString()}/orders?brandId=${brandA.toString()}`,
    );
    expect(res.body.orders).toHaveLength(1);
    expect(res.body.orders[0].externalOrderId).toBe('9001');
  });

  it('the batch list never crosses brands', async () => {
    const agent = await signedIn();
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/ingest-batches`);
    const b = await agent.get(`/api/operator/brands/${brandB.toString()}/ingest-batches`);
    expect(a.body.batches).toHaveLength(1);
    expect(b.body.batches).toHaveLength(1);
    expect(a.body.batches[0].id).not.toBe(b.body.batches[0].id);
  });

  it('the column mapping never crosses brands', async () => {
    const agent = await signedIn();
    await agent
      .put(`/api/operator/brands/${brandB.toString()}/column-mapping`)
      .send({ ...MAPPING, total: 'B Total' });
    const a = await agent.get(`/api/operator/brands/${brandA.toString()}/column-mapping`);
    expect(a.body.mapping.total).toBe('Total');
  });

  it('the export never crosses brands', async () => {
    const agent = await signedIn();
    await reauth(agent);
    const res = await agent.get(`/api/operator/brands/${brandB.toString()}/orders/export`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('9001');
    expect(res.text).not.toContain('1001');
  });

  it('an unknown brand id is a 404, not an empty list', async () => {
    const agent = await signedIn();
    const res = await agent.get(`/api/operator/brands/${new Types.ObjectId().toString()}/orders`);
    expect(res.status).toBe(404);
  });

  it('a malformed brand id is a 400', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/brands/not-an-id/orders');
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------ formula injection */

describe('export', () => {
  it('requires a fresh password check', async () => {
    const agent = await signedIn();
    await goStale();
    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/orders/export`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');

    // And is allowed again once the password is re-entered.
    await reauth(agent);
    expect((await agent.get(`/api/operator/brands/${brandA.toString()}/orders/export`)).status).toBe(
      200,
    );
  });

  /**
   * A customer-supplied discount code beginning with `=` is a formula when the
   * finance team opens the export in Excel. Neutralised on the way out, and
   * only on the way out — the stored value stays what the brand uploaded.
   */
  it('neutralises formula injection on the way out, not on the way in', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    const evil = csv(
      '2001,2026-08-04,10.00,10.00,GBP,"=HYPERLINK(""http://evil.test"",""claim"")",new,paid,,,',
      '2002,2026-08-05,10.00,10.00,GBP,+1234,new,paid,,,',
      '2003,2026-08-06,10.00,10.00,GBP,@SUM(A1),new,paid,,,',
      '2004,2026-08-07,10.00,10.00,GBP,-99,new,paid,,,',
    );
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, evil);

    // Stored verbatim: the raw record must stay faithful.
    const stored = await OrderModel.findOne({ brandId: brandA, externalOrderId: '2002' }).lean();
    expect(stored?.discountCodeUsed).toBe('+1234');

    await reauth(agent);
    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/orders/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');

    // Every dangerous leading character is quoted out of formula position.
    expect(res.text).toContain("'+1234");
    expect(res.text).toContain("'@SUM(A1)");
    expect(res.text).toContain("'-99");
    expect(res.text).toContain("'=HYPERLINK");
    // And no cell begins a formula, in any row.
    for (const line of res.text.trim().split('\n')) {
      for (const cell of line.split(',')) {
        const first = cell.replace(/^"/, '')[0] ?? '';
        expect(['=', '+', '@']).not.toContain(first);
      }
    }
  });

  it('exports no customer data beyond what the brand already holds', async () => {
    const agent = await signedIn();
    await saveMapping(agent, brandA);
    await post(agent, `/api/operator/brands/${brandA.toString()}/orders/commit`, BASE_CSV);
    await reauth(agent);
    const res = await agent.get(`/api/operator/brands/${brandA.toString()}/orders/export`);
    expect(res.text.split('\n')[0]).toBe(
      'externalOrderId,orderedAt,currency,totalMinor,subtotalMinor,discountCodeUsed,status,refundedMinor,customerType,source',
    );
  });
});
