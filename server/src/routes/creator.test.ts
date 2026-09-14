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
  CampaignCreatorModel,
  CampaignModel,
  CreatorModel,
  MagicLinkModel,
  OperatorModel,
  PostModel,
  SessionModel,
} from '../db/models/index.js';
import { mintToken } from '../lib/tokens.js';
import { loadConsentDocument } from '../config/consent.js';
import { clearRateLimits } from '../lib/rate-limit.js';
import { getStorage } from '../storage/index.js';

/**
 * Exercises the real stack: real Express, real Mongoose, real local storage,
 * real sharp-based image ingest. Nothing is mocked, so an invariant that only
 * fires at write time still fails the test.
 */

let app: Server;
let operatorId: Types.ObjectId;
let campaignId: Types.ObjectId;
let creatorId: Types.ObjectId;
let token: string;

/** A 1x1 PNG. Genuinely a PNG, so sharp will decode it. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** A larger PNG so two uploads can differ by content. */
const PNG_BYTES_2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M/wn4EIwDiqEAQAJIsD/8wqNiAAAAAASUVORK5CYII=',
  'base64',
);

async function makeLink(): Promise<string> {
  const minted = mintToken();
  await MagicLinkModel.create({
    tokenHash: minted.hash,
    creatorId,
    campaignId,
    issuedAt: new Date(),
    expiresAt: new Date(Date.now() + 15 * 60_000),
    issuedByOperatorId: operatorId,
  });
  return minted.raw;
}

/** A cookie-persisting agent that has exchanged a link for a session. */
async function signedIn(): Promise<TestAgent> {
  const agent = request.agent(app);
  const raw = await makeLink();
  const res = await agent.post('/api/creator/session/exchange').send({ token: raw });
  expect(res.status).toBe(201);
  return agent;
}

async function giveConsent(agent: TestAgent): Promise<void> {
  const doc = await loadConsentDocument();
  const res = await agent
    .post('/api/creator/consent')
    .send({ agreed: true, scopeVersion: doc.version });
  expect(res.status).toBe(201);
}

async function uploadScreenshot(agent: TestAgent, bytes = PNG_BYTES): Promise<string> {
  const presign = await agent
    .post('/api/creator/uploads/presign')
    .send({ campaignId: campaignId.toString(), contentType: 'image/png', byteLength: bytes.length });
  expect(presign.status).toBe(201);

  const url = new URL(presign.body.uploadUrl);
  const put = await request(app)
    .put(`${url.pathname}${url.search}`)
    .set('content-type', 'image/png')
    .send(bytes);
  expect(put.status).toBe(200);
  return presign.body.key as string;
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
    CampaignCreatorModel.deleteMany({}),
    PostModel.deleteMany({}),
    MagicLinkModel.deleteMany({}),
    SessionModel.deleteMany({}),
    AuditLogModel.deleteMany({}),
  ]);
  await clearRateLimits();

  operatorId = new Types.ObjectId();
  await OperatorModel.create({
    _id: operatorId,
    email: 'test-op@anton.example',
    displayName: 'Test Operator',
    passwordHash: 'placeholder',
    role: 'owner',
  });

  campaignId = new Types.ObjectId();
  await CampaignModel.create({
    _id: campaignId,
    brandId: new Types.ObjectId(),
    name: 'Test Campaign',
    brief: 'Test brief',
    objective: 'testing',
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

  creatorId = new Types.ObjectId();
  await CreatorModel.create({
    _id: creatorId,
    displayName: 'Test Creator',
    email: 'creator@example.com',
    handles: [{ platform: 'instagram', handle: 'test.creator', platformUserId: null, profileUrl: null }],
    followerSnapshots: [
      { platform: 'instagram', count: 9_000, capturedAt: new Date('2026-06-01T00:00:00Z'), source: 'manual' },
    ],
    status: 'invited',
  });

  await CampaignCreatorModel.create({
    campaignId,
    creatorId,
    status: 'accepted',
    invitedAt: new Date('2026-07-28T00:00:00Z'),
  });

  token = await makeLink();
});

/* ------------------------------------------------------- magic-link exchange */

describe('magic-link exchange', () => {
  it('rejects a malformed token without touching the database', async () => {
    const res = await request(app).post('/api/creator/session/exchange').send({ token: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_link');
  });

  it('rejects a well-formed token that was never issued', async () => {
    const res = await request(app)
      .post('/api/creator/session/exchange')
      .send({ token: mintToken().raw });
    expect(res.status).toBe(401);
  });

  it('exchanges a valid token and sets an httpOnly session cookie', async () => {
    const res = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(res.status).toBe(201);

    const cookies = res.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((c) => c.startsWith('anton_creator_session='));
    expect(session).toBeDefined();
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
  });

  it('spends the token: a second exchange with the same token is refused', async () => {
    const first = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(second.status).toBe(410);
    expect(second.body.error.code).toMatch(/already_used/);
  });

  it('refuses an expired token', async () => {
    await MagicLinkModel.updateOne(
      { tokenHash: { $exists: true } },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const res = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_expired');
  });

  it('refuses a revoked token', async () => {
    await MagicLinkModel.updateMany({}, { $set: { revokedAt: new Date() } });
    const res = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('link_revoked');
  });

  it("refuses a token belonging to a different creator's deleted account", async () => {
    await CreatorModel.updateOne({ _id: creatorId }, { $set: { status: 'removed' } });
    const res = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('creator_removed');
  });

  it('records the session with a hashed IP and a user agent, never a raw IP', async () => {
    await request(app)
      .post('/api/creator/session/exchange')
      .set('user-agent', 'TestBrowser/1.0')
      .send({ token });

    const session = await SessionModel.findOne({ creatorId }).lean();
    expect(session?.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(session?.userAgent).toBe('TestBrowser/1.0');

    const audit = await AuditLogModel.findOne({ action: 'creator.session.created' }).lean();
    expect(audit?.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(audit)).not.toContain('127.0.0.1');
  });

  it('rate limits repeated exchange attempts from one connection', async () => {
    let sawRateLimit = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await request(app)
        .post('/api/creator/session/exchange')
        .send({ token: mintToken().raw });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });

  it('never returns the session token in the response body', async () => {
    const res = await request(app).post('/api/creator/session/exchange').send({ token });
    expect(JSON.stringify(res.body)).not.toContain(token);
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
  });
});

/* ------------------------------------------------------------- sessions */

describe('sessions', () => {
  it('rejects an API call with no session cookie', async () => {
    const res = await request(app).get('/api/creator/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('no_session');
  });

  it('rejects a revoked session', async () => {
    const agent = await signedIn();
    await SessionModel.updateMany({ creatorId }, { $set: { revokedAt: new Date() } });
    const res = await agent.get('/api/creator/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('session_revoked');
  });

  it('rejects an expired session', async () => {
    const agent = await signedIn();
    await SessionModel.updateMany({ creatorId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await agent.get('/api/creator/session');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('session_expired');
  });

  it('lists signed-in devices and marks the current one', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/creator/sessions');
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].isThisDevice).toBe(true);
  });

  it('revoke-all kills every session and every unspent link', async () => {
    const agent = await signedIn();
    const spare = await makeLink();

    const res = await agent.post('/api/creator/sessions/revoke-all').send({});
    expect(res.status).toBe(200);
    expect(res.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

    expect((await agent.get('/api/creator/session')).status).toBe(401);
    // The unspent spare link is dead too, which is the point of the kill switch.
    const reuse = await request(app).post('/api/creator/session/exchange').send({ token: spare });
    expect(reuse.status).toBe(410);
  });
});

/* ----------------------------------------------------------------- consent */

describe('consent capture', () => {
  it('reports consent as required when none is on record', async () => {
    const agent = await signedIn();
    const res = await agent.get('/api/creator/session');
    expect(res.body.consent.required).toBe(true);
    expect(res.body.consent.reason).toBe('not_given');
    expect(res.body.consent.text.length).toBeGreaterThan(500);
  });

  it('refuses a submission before consent is given', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/jpeg', byteLength: 1000 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('consent_required');
  });

  it('rejects a non-affirmative consent body', async () => {
    const agent = await signedIn();
    const doc = await loadConsentDocument();
    const res = await agent
      .post('/api/creator/consent')
      .send({ agreed: false, scopeVersion: doc.version });
    expect(res.status).toBe(400);
  });

  it('rejects consent to a version other than the current document', async () => {
    const agent = await signedIn();
    const res = await agent
      .post('/api/creator/consent')
      .send({ agreed: true, scopeVersion: '1999-01-v0' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('consent_version_mismatch');
  });

  it('records consent with the document hash and a hashed IP', async () => {
    const agent = await signedIn();
    const doc = await loadConsentDocument();
    await giveConsent(agent);

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.consent?.documentSha256).toBe(doc.sha256);
    expect(creator?.consent?.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(creator?.status).toBe('active');
  });

  it('flags consent as stale when the document hash no longer matches', async () => {
    const agent = await signedIn();
    const doc = await loadConsentDocument();
    await CreatorModel.updateOne(
      { _id: creatorId },
      {
        $set: {
          consent: {
            grantedAt: new Date(),
            scopeVersion: doc.version,
            documentSha256: 'f'.repeat(64),
            ipHash: 'a'.repeat(64),
            method: 'web_form',
            withdrawnAt: null,
          },
        },
      },
    );
    const res = await agent.get('/api/creator/session');
    expect(res.body.consent.required).toBe(true);
    expect(res.body.consent.reason).toBe('document_changed');
  });

  it('blocks writes again after consent is withdrawn', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    await agent.post('/api/creator/consent/withdraw').send({});

    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/jpeg', byteLength: 1000 });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ upload */

describe('screenshot upload', () => {
  it('issues a key namespaced to the creator, never one the client chose', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/jpeg', byteLength: 50_000 });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(new RegExp(`^creators/${creatorId.toString()}/[a-f0-9-]+\\.jpg$`));
  });

  it('refuses a content type that is not an image', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'application/pdf', byteLength: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unsupported_type');
  });

  it('refuses an oversized upload', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/jpeg', byteLength: 11_000_000 });
    expect(res.status).toBe(413);
  });

  it('refuses a presign for a campaign the creator is not on', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: new Types.ObjectId().toString(), contentType: 'image/jpeg', byteLength: 1000 });
    expect(res.status).toBe(403);
  });

  it('rejects an upload whose signature was tampered with', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const presign = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/png', byteLength: 100 });
    const url = new URL(presign.body.uploadUrl);
    url.searchParams.set('sig', 'b'.repeat(64));
    const put = await request(app)
      .put(`${url.pathname}${url.search}`)
      .set('content-type', 'image/png')
      .send(PNG_BYTES);
    expect(put.status).toBe(403);
  });

  it('rejects an upload to a key the signature does not cover', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const presign = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/png', byteLength: 100 });
    const url = new URL(presign.body.uploadUrl);
    url.searchParams.set('key', 'creators/aaaaaaaaaaaaaaaaaaaaaaaa/evil.jpg');
    const put = await request(app)
      .put(`${url.pathname}${url.search}`)
      .set('content-type', 'image/png')
      .send(PNG_BYTES);
    expect(put.status).toBe(403);
  });

  it('rate limits uploads per creator', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    let sawRateLimit = false;
    for (let i = 0; i < 25; i += 1) {
      const res = await agent
        .post('/api/creator/uploads/presign')
        .send({ campaignId: campaignId.toString(), contentType: 'image/png', byteLength: 100 });
      if (res.status === 429) {
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);
  });
});

/* ------------------------------------------------------------- submission */

describe('post submission', () => {
  it('creates a post with a pending extraction and a server-computed hash', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);

    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      publicUrl: 'https://www.instagram.com/p/abc123/',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: key,
    });
    expect(res.status).toBe(201);

    const post = await PostModel.findById(res.body.id).lean();
    expect(post?.extraction?.status).toBe('pending');
    expect(post?.extraction?.sourceImageSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(post?.metrics.reach).toBeNull();
    // Trust signals are captured at submission, not bolted on later.
    expect(post?.trust?.submissionLagHours).toBeGreaterThanOrEqual(0);
    expect(typeof post?.trust?.exifPresent).toBe('boolean');
  });

  it('normalises the stored object: what lands in storage is a clean JPEG', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);
    await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: key,
    });

    const stored = await getStorage().readObject(key);
    // JPEG magic bytes: the PNG that was uploaded has been re-encoded.
    expect(stored[0]).toBe(0xff);
    expect(stored[1]).toBe(0xd8);
  });

  it('rejects a file renamed to an image but which is not one', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const presign = await agent
      .post('/api/creator/uploads/presign')
      .send({ campaignId: campaignId.toString(), contentType: 'image/png', byteLength: 100 });
    const url = new URL(presign.body.uploadUrl);

    // Declares image/png at the presign layer, but the bytes are a PDF.
    const notAnImage = Buffer.from('%PDF-1.7\n%bogus pdf content here\n', 'utf8');
    const put = await request(app)
      .put(`${url.pathname}${url.search}`)
      .set('content-type', 'image/png')
      .send(notAnImage);
    expect(put.status).toBe(200); // storage accepted the declared type

    // Ingest is where it dies: magic bytes say PDF, not PNG.
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: presign.body.key,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('not_an_image');
  });

  it("refuses a key belonging to another creator", async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const otherKey = `creators/${new Types.ObjectId().toString()}/${crypto.randomUUID()}.jpg`;
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: otherKey,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('key_not_yours');
  });

  it('refuses a structurally invalid key outright', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: '../../etc/passwd',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a submission whose upload never landed', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const ghost = `creators/${creatorId.toString()}/${crypto.randomUUID()}.jpg`;
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: ghost,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('upload_missing');
  });

  it('refuses the same screenshot content submitted twice', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const body = {
      campaignId: campaignId.toString(),
      platform: 'instagram' as const,
      format: 'reel' as const,
      postedAt: '2026-08-15T09:00:00Z',
    };
    const first = await uploadScreenshot(agent);
    expect((await agent.post('/api/creator/posts').send({ ...body, sourceImageKey: first })).status).toBe(201);

    const second = await uploadScreenshot(agent);
    const dup = await agent.post('/api/creator/posts').send({ ...body, sourceImageKey: second });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('already_submitted');
  });

  it('accepts genuinely different screenshots', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const body = {
      campaignId: campaignId.toString(),
      platform: 'instagram' as const,
      format: 'reel' as const,
      postedAt: '2026-08-15T09:00:00Z',
    };
    const first = await uploadScreenshot(agent, PNG_BYTES);
    await agent.post('/api/creator/posts').send({ ...body, sourceImageKey: first });

    const second = await uploadScreenshot(agent, PNG_BYTES_2);
    const res = await agent.post('/api/creator/posts').send({ ...body, sourceImageKey: second });
    expect(res.status).toBe(201);
  });

  it('rejects a malformed date', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: 'last Tuesday',
      sourceImageKey: key,
    });
    expect(res.status).toBe(400);
  });

  it('records a late submission as outside the window without rejecting it', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);
    const res = await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-02T09:00:00Z',
      sourceImageKey: key,
    });
    expect(res.status).toBe(201);
    const post = await PostModel.findById(res.body.id).lean();
    expect(post?.trust?.withinSubmissionWindow).toBe(false);
  });
});

/* ------------------------------------------------------------ data rights */

describe('data rights', () => {
  it('exports everything held, with working screenshot links', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);
    await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: key,
    });

    const res = await agent.get('/api/creator/export');
    expect(res.status).toBe(200);
    expect(res.body.profile.displayName).toBe('Test Creator');
    expect(res.body.posts).toHaveLength(1);
    expect(res.body.screenshots).toHaveLength(1);

    const download = new URL(res.body.screenshots[0].downloadUrl);
    const img = await request(app).get(`${download.pathname}${download.search}`);
    expect(img.status).toBe(200);
  });

  it('never puts a token hash in the export', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent.get('/api/creator/export');
    expect(JSON.stringify(res.body)).not.toContain('tokenHash');
  });

  it('requires typed confirmation to delete', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent.post('/api/creator/delete').send({ confirm: 'yes' });
    expect(res.status).toBe(400);
  });

  it('deletion actually removes objects from storage, not just database rows', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const key = await uploadScreenshot(agent);
    await agent.post('/api/creator/posts').send({
      campaignId: campaignId.toString(),
      platform: 'instagram',
      format: 'reel',
      postedAt: '2026-08-15T09:00:00Z',
      sourceImageKey: key,
    });

    const storage = getStorage();
    expect(await storage.objectExists(key)).toBe(true);

    const res = await agent.post('/api/creator/delete').send({ confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.body.screenshotsFailed).toBe(0);

    // The object is genuinely gone, not flagged.
    expect(await storage.objectExists(key)).toBe(false);
    expect(await PostModel.countDocuments({ creatorId })).toBe(0);

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.status).toBe('removed');
    expect(creator?.handles).toHaveLength(0);
    expect(creator?.consent?.withdrawnAt).not.toBeNull();

    // Deletion revokes the session AND clears the cookie, so the browser has
    // nothing left to send. Both belt and braces: the session row is dead even
    // if a copy of the cookie survives somewhere.
    const after = await agent.get('/api/creator/session');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('no_session');
    const sessions = await SessionModel.find({ creatorId }).lean();
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
  });
});

/* --------------------------------------------------------------- followers */

describe('follower snapshots', () => {
  it('appends rather than overwriting, preserving history', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    await agent.post('/api/creator/followers').send({ platform: 'instagram', count: 12_500 });

    const creator = await CreatorModel.findById(creatorId).lean();
    expect(creator?.followerSnapshots).toHaveLength(2);
    expect(creator?.followerSnapshots[0]?.count).toBe(9_000);
    expect(creator?.followerSnapshots[1]?.count).toBe(12_500);
  });

  it('refuses a platform the creator has no handle for', async () => {
    const agent = await signedIn();
    await giveConsent(agent);
    const res = await agent.post('/api/creator/followers').send({ platform: 'tiktok', count: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('no_handle');
  });
});

/* -------------------------------------------------------------- hardening */

describe('response hardening', () => {
  it('serves a robots.txt disallowing the share and creator paths', async () => {
    const res = await request(app).get('/robots.txt');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Disallow: /r/');
  });

  it('sets x-robots-tag noindex on API responses', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-robots-tag']).toContain('noindex');
  });
});
