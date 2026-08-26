/**
 * Live smoke test of every HTTP endpoint.
 *
 * The unit tests exercise routes individually with hand-built fixtures. This
 * drives the whole surface against a running server and seeded data, in the
 * order a real operator would, so a route that exists but is unreachable — a
 * verb mismatch, a mount-order shadow, a typo in a path — shows up as a 404
 * rather than passing quietly because no test happened to call it.
 */
import * as OTPAuth from 'otpauth';

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:5310';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

interface Result {
  name: string;
  method: string;
  path: string;
  status: number;
  expected: number[];
  ok: boolean;
  note?: string;
}

const results: Result[] = [];
let cookie = '';

function totp(): string {
  return new OTPAuth.TOTP({
    issuer: 'Anton',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(TOTP_SECRET),
  }).generate();
}

async function hit(
  name: string,
  method: string,
  path: string,
  expected: number[],
  body?: unknown,
  useCookie = true,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (useCookie && cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const setCookie = res.headers.get('set-cookie');
  if (setCookie && useCookie) {
    const pair = setCookie.split(';')[0];
    if (pair) cookie = cookie ? `${cookie}; ${pair}` : pair;
  }

  let json: unknown = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 120);
  }

  const ok = expected.includes(res.status);
  results.push({
    name,
    method,
    path,
    status: res.status,
    expected,
    ok,
    ...(ok ? {} : { note: typeof json === 'object' ? JSON.stringify(json).slice(0, 160) : String(json) }),
  });
  return { status: res.status, json };
}

function pick<T>(obj: unknown, path: string): T | undefined {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], obj) as T;
}

/* --------------------------------------------------------------- public */

await hit('health', 'GET', '/api/health', [200], undefined, false);
await hit('robots.txt', 'GET', '/robots.txt', [200], undefined, false);
await hit('unknown route 404s', 'GET', '/api/nope', [404], undefined, false);

/* ------------------------------------------------------------- operator */

const login = await hit('operator login', 'POST', '/api/operator/auth/login', [200], {
  email: 'ops@anton.example',
  password: 'anton-dev-password',
  totpCode: totp(),
});
if (login.status !== 200) {
  console.error('Login failed — cannot smoke the authenticated surface.');
  console.error(JSON.stringify(login.json));
  process.exit(1);
}

await hit('operator me', 'GET', '/api/operator/auth/me', [200]);
await hit('operator reauth', 'POST', '/api/operator/auth/reauth', [200], {
  password: 'anton-dev-password',
});
await hit('operator dashboard', 'GET', '/api/operator/dashboard', [200]);

const queue = await hit('queue (needs_review)', 'GET', '/api/operator/queue?status=needs_review', [200]);
const firstPostId = pick<string>(queue.json, 'items.0.id');

await hit('queue (all)', 'GET', '/api/operator/queue?status=all&limit=5', [200]);
await hit('queue rejects bad status', 'GET', '/api/operator/queue?status=bogus', [400]);

if (firstPostId) {
  await hit('post raw output', 'GET', `/api/operator/posts/${firstPostId}/raw`, [200]);
  await hit('post raw rejects bad id', 'GET', '/api/operator/posts/nope/raw', [400]);
  await hit('spot audit', 'POST', `/api/operator/posts/${firstPostId}/spot-audit`, [200], {
    outcome: 'passed',
    note: 'smoke test',
  });
} else {
  results.push({
    name: 'post routes',
    method: '-',
    path: '-',
    status: 0,
    expected: [200],
    ok: false,
    note: 'no post in queue to exercise',
  });
}

/* --------------------------------------------------------------- roster */

const roster = await hit('roster', 'GET', '/api/operator/roster', [200]);
const firstCreatorId = pick<string>(roster.json, 'creators.0.id');

await hit('roster filter niche', 'GET', '/api/operator/roster?niche=skincare', [200]);
await hit('roster filter band', 'GET', '/api/operator/roster?band=nano', [200]);
await hit('roster search', 'GET', '/api/operator/roster?search=a', [200]);
await hit('roster sort engagement', 'GET', '/api/operator/roster?sort=engagement', [200]);
await hit('nudges', 'GET', '/api/operator/nudges', [200]);
await hit('nudges threshold', 'GET', '/api/operator/nudges?thresholdHours=24', [200]);

const campaigns = await hit('campaigns', 'GET', '/api/operator/campaigns', [200]);
const firstCampaignId = pick<string>(campaigns.json, 'campaigns.0.id');

if (firstCreatorId) {
  await hit('creator detail', 'GET', `/api/operator/creators/${firstCreatorId}`, [200]);
  await hit('creator patch', 'PATCH', `/api/operator/creators/${firstCreatorId}`, [200], {
    notes: 'smoke test note',
  });
  await hit('creator follower snapshot', 'POST', `/api/operator/creators/${firstCreatorId}/followers`, [201], {
    platform: 'instagram',
    count: 12345,
  });
}

if (firstCampaignId) {
  // The UI calls this; the verb must match what the router registered.
  await hit('benchmark (PUT)', 'PUT', `/api/operator/campaigns/${firstCampaignId}/benchmark`, [200], {
    label: 'Smoke benchmark',
    quotedFeeMinor: 1_800_000,
    quotedReach: 620_000,
    sourceNote: 'Smoke test',
  });
  // The route is PUT-only. Asserting POST 404s guards against a future edit
  // that adds a POST alias and lets the two verbs drift apart again.
  await hit('benchmark is PUT-only', 'POST', `/api/operator/campaigns/${firstCampaignId}/benchmark`, [404], {
    label: 'Smoke benchmark',
    quotedFeeMinor: 1_800_000,
    quotedReach: 620_000,
    sourceNote: 'Smoke test',
  });
  await hit('benchmark rejects empty source note', 'PUT', `/api/operator/campaigns/${firstCampaignId}/benchmark`, [400], {
    label: 'x',
    quotedFeeMinor: 1,
    quotedReach: 1,
    sourceNote: '',
  });
}

/* --------------------------------------------------------------- invites */

if (firstCreatorId) {
  const invites = await hit('bulk invite', 'POST', '/api/operator/invites', [201], {
    creatorIds: [firstCreatorId],
    campaignId: null,
  });
  const url = pick<string>(invites.json, 'links.0.url');
  if (url) {
    const token = new URL(url).pathname.split('/').pop() ?? '';
    await hit('creator exchange (fresh token)', 'POST', '/api/creator/session/exchange', [201], { token }, false);
    await hit('creator exchange (reused token)', 'POST', '/api/creator/session/exchange', [410], { token }, false);
  }
  await hit('revoke creator links', 'POST', `/api/operator/creators/${firstCreatorId}/revoke-links`, [200], {});
}

/* ----------------------------------------------------------- share links */

let shareToken = '';
let shareLinkId = '';
if (firstCampaignId) {
  const created = await hit('create share link', 'POST', '/api/operator/share-links', [201], {
    campaignId: firstCampaignId,
    label: 'Smoke report',
    expiresInDays: 30,
    showCompensation: false,
    showCreatorHandles: true,
    requireEmailGate: false,
  });
  const url = pick<string>(created.json, 'url');
  shareLinkId = pick<string>(created.json, 'id') ?? '';
  if (url) shareToken = new URL(url).pathname.split('/').pop() ?? '';
}

await hit('list share links', 'GET', '/api/operator/share-links', [200]);

/* --------------------------------------------------------------- report */

if (shareToken) {
  await hit('public report', 'GET', `/api/report/${shareToken}`, [200], undefined, false);
  await hit('report request code', 'POST', `/api/report/${shareToken}/request-code`, [201], { email: 'smoke@x.com' }, false);
  await hit('report verify bad code', 'POST', `/api/report/${shareToken}/verify-code`, [401], { email: 'smoke@x.com', code: '000000' }, false);
}
await hit('report unknown token', 'GET', `/api/report/${'x'.repeat(43)}`, [404], undefined, false);
await hit('report malformed token', 'GET', '/api/report/short', [404], undefined, false);

/* --------------------------------------------------------------- export */

await hit('export posts csv', 'GET', '/api/operator/export/posts?format=csv', [200]);
await hit('export posts json', 'GET', '/api/operator/export/posts?format=json', [200]);
await hit('export audit', 'GET', '/api/operator/export/audit', [200]);
await hit('retention preview', 'GET', '/api/operator/retention/preview', [200]);
await hit('retention purge needs confirm', 'POST', '/api/operator/retention/purge', [400], { confirm: 'no' });

/* ----------------------------------------------------- revoke + sign out */

if (shareLinkId) {
  await hit('revoke share link', 'POST', `/api/operator/share-links/${shareLinkId}/revoke`, [200], {});
  if (shareToken) {
    await hit('revoked report is gone', 'GET', `/api/report/${shareToken}`, [410], undefined, false);
  }
}

await hit('operator logout', 'POST', '/api/operator/auth/logout', [200], {});
await hit('queue after logout', 'GET', '/api/operator/queue', [401]);

/* --------------------------------------------------------------- report */

const failed = results.filter((r) => !r.ok);
const pad = (s: string, n: number): string => s.padEnd(n).slice(0, n);

console.log('');
for (const r of results) {
  const mark = r.ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${pad(r.method, 6)} ${pad(r.path, 52)} ${r.status} (want ${r.expected.join('/')})`);
  if (r.note) console.log(`       ${r.note}`);
}

console.log(`\n${results.length - failed.length}/${results.length} endpoints behaved as expected`);
if (failed.length > 0) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  ${f.method} ${f.path} -> ${f.status}, wanted ${f.expected.join('/')}`);
  process.exitCode = 1;
}
