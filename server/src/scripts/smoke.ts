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
    // Never follow. A redirect is a result to assert, not a step to take —
    // and the short-link route deliberately points off this host.
    redirect: 'manual',
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

/** Same as `hit`, but posts a raw CSV body rather than JSON. */
async function hitCsv(
  name: string,
  path: string,
  expected: number[],
  body: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'text/csv' };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.slice(0, 120);
  }

  const ok = expected.includes(res.status);
  results.push({
    name,
    method: 'POST',
    path,
    status: res.status,
    expected,
    ok,
    ...(ok ? {} : { note: typeof json === 'object' ? JSON.stringify(json).slice(0, 160) : String(json) }),
  });
  return { status: res.status, json };
}

/**
 * Records a failure when a value the rest of the script depends on is missing.
 *
 * Without this an id that moves in a response body makes every test downstream
 * of it silently skip, and the run still prints all green — which is the exact
 * failure this script exists to catch.
 */
function need<T>(what: string, value: T | undefined): T | undefined {
  if (value === undefined || value === null) {
    results.push({
      name: `missing ${what}`,
      method: '-',
      path: '-',
      status: 0,
      expected: [200],
      ok: false,
      note: `${what} was not in the response, so everything depending on it was skipped`,
    });
  }
  return value;
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

/* -------------------------------------------------- tracking and ingest */

/**
 * Steps 2 to 5. Every commerce route is scoped by a brand id in the path, so a
 * wrong one must 404 rather than quietly widen the scope — which also means the
 * brand, the campaign and the participation used below all have to be the SAME
 * tenant. Picking them independently is how the first version of this section
 * spent three requests proving the tenant check works.
 */
interface SmokeCampaign {
  id: string;
  brandId: string;
}
const allCampaigns = (pick<SmokeCampaign[]>(campaigns.json, 'campaigns') ?? []).filter(
  (c): c is SmokeCampaign => typeof c?.id === 'string' && typeof c?.brandId === 'string',
);
const brandOfCampaign = new Map(allCampaigns.map((c) => [c.id, c.brandId]));

let issuedAssetId: string | undefined;
let issuedShortCode: string | undefined;
let joinIdForMoney: string | undefined;
let firstBrandId: string | undefined;

if (firstCreatorId) {
  // The join row is what a tracking asset hangs off. Creator detail is the
  // only route that exposes it, so the id comes from there.
  const detail = await hit('creator detail for join id', 'GET', `/api/operator/creators/${firstCreatorId}`, [200]);
  const participation = pick<{ _id: string; campaignId: string }[]>(detail.json, 'participation') ?? [];
  // The brand is taken FROM the join, not chosen separately, so every route
  // below is exercised against one consistent tenant.
  const usable = participation.find((p) => brandOfCampaign.has(String(p.campaignId)));
  const joinId = usable?._id;
  if (usable) {
    firstBrandId = brandOfCampaign.get(String(usable.campaignId));
  }

  if (joinId) {
    /**
     * One active code per creator per campaign is enforced, and the seed issues
     * codes of its own — so this join may already hold one. It is revoked
     * first rather than tolerated, which keeps the run deterministic on a fresh
     * reset instead of passing only when a previous run happened to clear it.
     */
    const existing = await hit('existing assets for join', 'GET', `/api/operator/tracking-assets?campaignCreatorId=${joinId}&status=active`, [200]);
    for (const asset of pick<{ id: string; type: string }[]>(existing.json, 'assets') ?? []) {
      if (asset.type === 'discount_code') {
        await hit('clear seeded code', 'POST', `/api/operator/tracking-assets/${asset.id}/revoke`, [200], {
          reason: 'smoke test: making room for a fresh code',
        });
      }
    }

    // An explicit stub, because the seed now issues codes of its own and a
    // generated one could collide with a creator's existing code.
    const code = await hit('issue discount code', 'POST', '/api/operator/tracking-assets', [201], {
      campaignCreatorId: joinId,
      type: 'discount_code',
      // Letters only — the stub has to survive being read aloud — and random,
      // so running smoke twice does not collide on the brand's unique index.
      codeStub: `SMK${Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('')}`,
      commissionRateBps: 1000,
      commissionRateBasis: 'order_subtotal',
    });
    issuedAssetId = need('discount code id', pick<string>(code.json, 'id'));

    const link = await hit('issue tracked link', 'POST', '/api/operator/tracking-assets', [201], {
      campaignCreatorId: joinId,
      type: 'tracked_link',
      destinationUrl: 'https://brand.example/collection',
      commissionRateBps: 500,
      commissionRateBasis: 'order_subtotal',
    });
    issuedShortCode = need('tracked link short code', pick<string>(link.json, 'shortCode'));

    await hit('list assets for join', 'GET', `/api/operator/tracking-assets?campaignCreatorId=${joinId}`, [200]);
    joinIdForMoney = joinId;
  } else {
    results.push({
      name: 'tracking assets',
      method: '-',
      path: '-',
      status: 0,
      expected: [201],
      ok: false,
      note: 'no campaign participation to hang a tracking asset off',
    });
  }
}

await hit('list tracking assets', 'GET', '/api/operator/tracking-assets?status=all', [200]);
await hit('tracking list rejects bad status', 'GET', '/api/operator/tracking-assets?status=bogus', [400]);

if (issuedShortCode) {
  // Public, unauthenticated, and must redirect rather than render.
  await hit('short link redirects', 'GET', `/t/${issuedShortCode}`, [302, 301], undefined, false);
}
await hit('unknown short link 404s', 'GET', '/t/ZZZZZZZZ', [404], undefined, false);

if (issuedAssetId) {
  await hit('revoke tracking asset', 'POST', `/api/operator/tracking-assets/${issuedAssetId}/revoke`, [200], {
    reason: 'smoke test',
  });
  await hit('revoke needs a reason', 'POST', `/api/operator/tracking-assets/${issuedAssetId}/revoke`, [400], {});
}

if (firstBrandId) {
  await hit('column mapping empty', 'GET', `/api/operator/brands/${firstBrandId}/column-mapping`, [200]);
  await hit('column mapping guess', 'POST', `/api/operator/brands/${firstBrandId}/column-mapping/guess`, [200], {
    headerRow: 'Order ID,Date,Total,Subtotal,Currency,Discount Code,Status,Landing Site',
  });
  await hit('save column mapping', 'PUT', `/api/operator/brands/${firstBrandId}/column-mapping`, [200], {
    externalOrderId: 'Order ID',
    orderedAt: 'Date',
    total: 'Total',
    subtotal: 'Subtotal',
    currency: 'Currency',
    discountCode: 'Discount Code',
    status: 'Status',
    attributionRef: 'Landing Site',
    fallbackCurrency: 'GBP',
  });
  await hit('column mapping rejects blank id column', 'PUT', `/api/operator/brands/${firstBrandId}/column-mapping`, [400], {
    externalOrderId: '',
    orderedAt: 'Date',
    total: 'Total',
    fallbackCurrency: 'GBP',
  });

  const csvBody = [
    'Order ID,Date,Total,Subtotal,Currency,Discount Code,Status,Landing Site',
    'SMOKE-1,2026-08-04,120.00,100.00,GBP,SMOKE10,paid,',
    'SMOKE-2,2026-08-05,60.50,60.50,GBP,,paid,',
  ].join('\n');

  await hitCsv('preview orders', `/api/operator/brands/${firstBrandId}/orders/preview`, [200], csvBody);
  await hitCsv('preview rejects an xlsx', `/api/operator/brands/${firstBrandId}/orders/preview`, [400], 'PK\u0003\u0004rest');
  await hitCsv('commit orders', `/api/operator/brands/${firstBrandId}/orders/commit`, [201], csvBody);
  // Idempotency, live: the same bytes again must insert nothing.
  const again = await hitCsv('commit is idempotent', `/api/operator/brands/${firstBrandId}/orders/commit`, [201], csvBody);
  if (pick<number>(again.json, 'rowsInserted') !== 0) {
    results.push({
      name: 'commit is idempotent',
      method: 'POST',
      path: `/api/operator/brands/${firstBrandId}/orders/commit`,
      status: 201,
      expected: [201],
      ok: false,
      note: `re-uploading the same file inserted ${pick<number>(again.json, 'rowsInserted')} rows`,
    });
  }

  await hit('list orders', 'GET', `/api/operator/brands/${firstBrandId}/orders`, [200]);
  await hit('list ingest batches', 'GET', `/api/operator/brands/${firstBrandId}/ingest-batches`, [200]);
  await hit('orders export', 'GET', `/api/operator/brands/${firstBrandId}/orders/export`, [200]);
  await hit('orders 404 on unknown brand', 'GET', '/api/operator/brands/000000000000000000000000/orders', [404]);
  await hit('orders 400 on malformed brand', 'GET', '/api/operator/brands/nope/orders', [400]);


  /* ------------------------------------------ attribution and commission */

  await hit('run attribution', 'POST', `/api/operator/brands/${firstBrandId}/attribution/run`, [200], {});
  // A second run must be a no-op: created 0, and nothing superseded.
  const rerun = await hit('attribution re-run is idempotent', 'POST', `/api/operator/brands/${firstBrandId}/attribution/run`, [200], {});
  if (pick<number>(rerun.json, 'created') !== 0 || pick<number>(rerun.json, 'superseded') !== 0) {
    results.push({
      name: 'attribution re-run is idempotent',
      method: 'POST',
      path: `/api/operator/brands/${firstBrandId}/attribution/run`,
      status: 200,
      expected: [200],
      ok: false,
      note: `re-running created ${pick<number>(rerun.json, 'created')} and superseded ${pick<number>(rerun.json, 'superseded')}`,
    });
  }

  await hit('attribution list', 'GET', `/api/operator/brands/${firstBrandId}/attributions`, [200]);
  await hit('unattributed list', 'GET', `/api/operator/brands/${firstBrandId}/attribution/unattributed`, [200]);
  await hit('attribution conflicts', 'GET', `/api/operator/brands/${firstBrandId}/attribution/conflicts`, [200]);
  await hit('attribution list rejects bad method', 'GET', `/api/operator/brands/${firstBrandId}/attributions?method=bogus`, [400]);

  await hit('post commission', 'POST', `/api/operator/brands/${firstBrandId}/commission/post`, [200], {});
  const repost = await hit('commission re-post is idempotent', 'POST', `/api/operator/brands/${firstBrandId}/commission/post`, [200], {});
  if (pick<number>(repost.json, 'accrualsCreated') !== 0) {
    results.push({
      name: 'commission re-post is idempotent',
      method: 'POST',
      path: `/api/operator/brands/${firstBrandId}/commission/post`,
      status: 200,
      expected: [200],
      ok: false,
      note: `re-posting accrued ${pick<number>(repost.json, 'accrualsCreated')} more entries`,
    });
  }

  const balances = await hit('commission balances', 'GET', `/api/operator/brands/${firstBrandId}/commission/balances`, [200]);
  await hit('commission reconciliation', 'GET', `/api/operator/brands/${firstBrandId}/commission/reconciliation`, [200]);
  await hit('commission export', 'GET', `/api/operator/brands/${firstBrandId}/commission/export`, [200]);
  await hit('payments list', 'GET', `/api/operator/brands/${firstBrandId}/commission/payments`, [200]);

  const balanceCreatorId = pick<string>(balances.json, 'balances.0.creatorId');
  if (balanceCreatorId) {
    await hit('creator ledger', 'GET', `/api/operator/brands/${firstBrandId}/creators/${balanceCreatorId}/ledger`, [200]);
  }

  if (joinIdForMoney) {
    await hit('adjustment', 'POST', `/api/operator/brands/${firstBrandId}/commission/adjustments`, [201], {
      campaignCreatorId: joinIdForMoney,
      amount: { amountMinor: 500, currency: 'GBP' },
      reason: 'Smoke test adjustment.',
    });
    await hit('adjustment needs a reason', 'POST', `/api/operator/brands/${firstBrandId}/commission/adjustments`, [400], {
      campaignCreatorId: joinIdForMoney,
      amount: { amountMinor: 500, currency: 'GBP' },
      reason: '',
    });
    const payment = await hit('record payment', 'POST', `/api/operator/brands/${firstBrandId}/commission/payments`, [201], {
      campaignCreatorId: joinIdForMoney,
      amount: { amountMinor: 100, currency: 'GBP' },
      paidAt: '2026-08-20T00:00:00Z',
      method: 'bank transfer',
    });
    await hit('payment cannot be in the future', 'POST', `/api/operator/brands/${firstBrandId}/commission/payments`, [400], {
      campaignCreatorId: joinIdForMoney,
      amount: { amountMinor: 100, currency: 'GBP' },
      paidAt: '2099-01-01T00:00:00Z',
    });
    const paymentId = need('payment id', pick<string>(payment.json, 'paymentId'));
    if (paymentId) {
      await hit('void payment', 'POST', `/api/operator/brands/${firstBrandId}/commission/payments/${paymentId}/void`, [200], {
        reason: 'smoke test',
      });
      await hit('void is not repeatable', 'POST', `/api/operator/brands/${firstBrandId}/commission/payments/${paymentId}/void`, [404], {
        reason: 'smoke test',
      });
    }
  }

  const batches = await hit('batches for rollback', 'GET', `/api/operator/brands/${firstBrandId}/ingest-batches`, [200]);
  const batchId = pick<string>(batches.json, 'batches.0.id');
  if (batchId) {
    await hit('rollback batch', 'POST', `/api/operator/brands/${firstBrandId}/ingest-batches/${batchId}/rollback`, [200], {});
    await hit('rollback is not repeatable', 'POST', `/api/operator/brands/${firstBrandId}/ingest-batches/${batchId}/rollback`, [409], {});
  }
}


  /* -------------------------------------------------- licensing and ads */

  /**
   * The post has to be one THIS creator made on THIS campaign — the route
   * rejects anything else, and picking whatever was first in the review queue
   * is how the first version of this section tested the guard instead of the
   * feature.
   */
  const licensablePostId =
    firstCreatorId && firstCampaignId
      ? pick<{ id: string; campaignId: string }[]>(
          (await hit('creator detail for a licensable post', 'GET', `/api/operator/creators/${firstCreatorId}`, [200]))
            .json,
          'posts',
        )?.find((p) => String(p.campaignId) === String(firstCampaignId))?.id
      : undefined;

  if (firstCampaignId && joinIdForMoney && licensablePostId) {
    const licence = await hit('request a licence', 'POST', '/api/operator/licences/request', [201], {
      campaignCreatorId: joinIdForMoney,
      scope: 'named_posts',
      postIds: [licensablePostId],
      permittedUses: ['organic_reshare', 'paid_amplification'],
      territory: ['GB'],
      startsAt: '2026-08-01T00:00:00Z',
      endsAt: null,
      modificationPermitted: true,
    });
    // An operator request must leave the licence permitting nothing.
    const state = pick<string>(licence.json, 'state');
    if (state !== 'awaiting_creator') {
      results.push({
        name: 'a requested licence permits nothing',
        method: 'POST',
        path: '/api/operator/licences/request',
        status: 201,
        expected: [201],
        ok: false,
        note: `a fresh request came back as "${state}", not "awaiting_creator"`,
      });
    }

    await hit('licence request rejects no uses', 'POST', '/api/operator/licences/request', [400], {
      campaignCreatorId: joinIdForMoney,
      scope: 'named_posts',
      postIds: [licensablePostId],
      permittedUses: [],
      territory: ['GB'],
      startsAt: '2026-08-01T00:00:00Z',
    });

    await hit('licence list', 'GET', `/api/operator/campaigns/${firstCampaignId}/licences`, [200]);
    const readiness = await hit('ad readiness', 'GET', `/api/operator/campaigns/${firstCampaignId}/ad-readiness`, [200]);

    // Nothing is grantable by an operator, so nothing can be ad-ready yet.
    if ((pick<number>(readiness.json, 'counts.ready') ?? 0) > 0) {
      results.push({
        name: 'nothing is ad-ready without a creator grant',
        method: 'GET',
        path: `/api/operator/campaigns/${firstCampaignId}/ad-readiness`,
        status: 200,
        expected: [200],
        ok: false,
        note: 'a post was reported ad-ready although no creator has granted a licence',
      });
    }

    const licenceId = need('licence id', pick<string>(licence.json, 'id'));
    if (licenceId) {
      await hit('operator cannot grant', 'POST', `/api/operator/licences/${licenceId}/grant`, [404], {
        agree: true,
      });
      await hit('revoke needs a reason', 'POST', `/api/operator/licences/${licenceId}/revoke`, [400], {
        reason: '',
      });
      await hit('revoke licence', 'POST', `/api/operator/licences/${licenceId}/revoke`, [200], {
        reason: 'smoke test',
      });
      await hit('revoke is not repeatable', 'POST', `/api/operator/licences/${licenceId}/revoke`, [404], {
        reason: 'smoke test',
      });
    }
  }


  /* ------------------------------------------------------ trust domains */

  await hit('trust domain vocabulary', 'GET', '/api/operator/trust-domains', [200]);
  if (firstCreatorId) {
    await hit('tag trust domains', 'PUT', `/api/operator/creators/${firstCreatorId}/trust-domains`, [200], {
      domains: ['Budget Picks', 'ingredient-science'],
    });
    await hit('trust domains capped at three', 'PUT', `/api/operator/creators/${firstCreatorId}/trust-domains`, [400], {
      domains: ['budget_picks', 'ingredient_science', 'sensitive_skin', 'transformation'],
    });
  }
  if (firstCampaignId) {
    const breakdown = await hit('trust domain breakdown', 'GET', `/api/operator/campaigns/${firstCampaignId}/trust-domains`, [200]);
    // A rate below the minimum sample must be withheld at source.
    const leaked = (pick<{ sampleSufficient: boolean; ordersPerThousandReach: number | null }[]>(breakdown.json, 'domains') ?? [])
      .some((d) => !d.sampleSufficient && d.ordersPerThousandReach !== null);
    if (leaked) {
      results.push({
        name: 'no rate below the minimum sample',
        method: 'GET',
        path: `/api/operator/campaigns/${firstCampaignId}/trust-domains`,
        status: 200,
        expected: [200],
        ok: false,
        note: 'a domain below the minimum sample was reported with a rate',
      });
    }
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
