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

let app: Server;
let operatorId: Types.ObjectId;
let creatorId: Types.ObjectId;
let campaignId: Types.ObjectId;

const PASSWORD = 'export-test-password';
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
    .send({ email: 'export@anton.example', password: PASSWORD, totpCode: code() });
  expect(res.status).toBe(200);
  return agent;
}

/** Ages the session's last password check past the re-auth window. */
async function ageReauth(): Promise<void> {
  await SessionModel.updateMany(
    { subjectKind: 'operator' },
    { $set: { lastReauthAt: new Date(Date.now() - 60 * 60_000) } },
  );
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
    email: 'export@anton.example',
    displayName: 'Export Operator',
    passwordHash: await hashPassword(PASSWORD),
    role: 'owner',
    totpSecret: TOTP_SECRET,
    totpEnrolledAt: new Date('2026-01-01T00:00:00Z'),
  });

  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Export, Creator',
    handles: [{ platform: 'instagram', handle: 'export.creator' }],
    nicheTags: ['skincare', 'fitness'],
    status: 'active',
  });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId: new Types.ObjectId(),
    name: 'Export "quoted" Campaign',
    status: 'live',
    platforms: ['instagram'],
    startDate: new Date('2026-08-01T00:00:00Z'),
    endDate: new Date('2026-09-30T00:00:00Z'),
    deliverableSpec: [{ format: 'reel', count: 1 }],
    compensationModel: 'gifted',
    currency: 'GBP',
    budgetTotal: { amountMinor: 1_000, currency: 'GBP' },
    defaultPerCreatorRate: { amountMinor: 0, currency: 'GBP' },
  });

  const base = {
    creatorId,
    campaignId,
    platform: 'instagram' as const,
    format: 'reel' as const,
    postedAt: new Date('2026-08-15T09:00:00Z'),
    metricSource: 'screenshot' as const,
    submittedAt: new Date(),
  };

  await PostModel.create({
    ...base,
    metrics: { reach: 8_000, likes: 400, comments: 20 },
    extraction: {
      sourceImageKey: `creators/${creatorId.toString()}/a.jpg`,
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
  });

  await PostModel.create({
    ...base,
    metrics: { reach: 99_999, likes: 50_000 },
    extraction: {
      sourceImageKey: `creators/${creatorId.toString()}/b.jpg`,
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
  });
});

describe('bulk export requires a fresh password check', () => {
  it('allows the export straight after signing in', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/posts?format=json');
    expect(res.status).toBe(200);
  });

  it('refuses once the session has been open a while', async () => {
    const agent = await signedIn();
    await ageReauth();

    const res = await agent.get('/api/operator/export/posts?format=json');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');
  });

  it('allows it again after the password is re-confirmed', async () => {
    const agent = await signedIn();
    await ageReauth();
    expect((await agent.get('/api/operator/export/posts?format=json')).status).toBe(403);

    const reauth = await agent.post('/api/operator/auth/reauth').send({ password: PASSWORD });
    expect(reauth.status).toBe(200);

    expect((await agent.get('/api/operator/export/posts?format=json')).status).toBe(200);
  });

  it('rejects a wrong password at re-auth', async () => {
    const agent = await signedIn();
    await ageReauth();
    const res = await agent.post('/api/operator/auth/reauth').send({ password: 'nope' });
    expect(res.status).toBe(401);

    // Still blocked.
    expect((await agent.get('/api/operator/export/posts?format=json')).status).toBe(403);
  });

  it('guards the retention purge the same way', async () => {
    const agent = await signedIn();
    await ageReauth();
    const res = await agent.post('/api/operator/retention/purge').send({ confirm: 'PURGE' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('reauth_required');
  });

  it('requires typed confirmation for the purge even when freshly authed', async () => {
    const agent = await signedIn();
    const res = await agent.post('/api/operator/retention/purge').send({ confirm: 'yes' });
    expect(res.status).toBe(400);
  });
});

describe('export contents', () => {
  it('excludes unverified posts by default', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/posts?format=json');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].reach).toBe(8_000);
  });

  it('includes them when explicitly asked', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/posts?format=json&includeUnverified=true');
    expect(res.body.rows).toHaveLength(2);
  });

  it('carries provenance so a stray CSV still says where its numbers came from', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/posts?format=json');
    const row = res.body.rows[0];
    expect(row.metricSource).toBe('screenshot');
    expect(row.extractionStatus).toBe('verified');
    expect(row.sourceImageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.note).toMatch(/not platform-verified/);
  });

  it('escapes commas and quotes in CSV rather than corrupting columns', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/posts?format=csv');
    expect(res.headers['content-type']).toContain('text/csv');

    const text = res.text;
    // Creator name contains a comma; niches contain a semicolon-joined list;
    // the campaign name contains double quotes.
    expect(text).toContain('"Export, Creator"');
    expect(text).toContain('"Export ""quoted"" Campaign"');

    // Header count and row count must match, which is what escaping protects.
    const lines = text.trim().split('\n');
    const headerCols = (lines[0]?.match(/,/g) ?? []).length;
    const dataLine = lines[1] ?? '';
    let inQuote = false;
    let commas = 0;
    for (const ch of dataLine) {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) commas += 1;
    }
    expect(commas).toBe(headerCols);
  });

  it('audits every bulk export', async () => {
    const agent = await signedIn();
    await agent.get('/api/operator/export/posts?format=csv');
    const audit = await AuditLogModel.findOne({ action: 'operator.bulk.export' }).lean();
    expect(audit).not.toBeNull();
    expect(audit?.actorId?.toString()).toBe(operatorId.toString());
  });

  it('exports the audit trail itself', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/operator/export/audit');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('refuses every export route with no session', async () => {
    for (const path of ['/api/operator/export/posts', '/api/operator/export/audit', '/api/operator/retention/preview']) {
      expect((await request(app).get(path)).status).toBe(401);
    }
  });
});
