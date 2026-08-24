# Anton — Creator Analytics

Per-post performance tracking for a roster of micro and nano creators on
Instagram and TikTok, built to prove one claim with receipts: **100
micro-influencers beat 1 mega-influencer on cost per engaged reach.**

## Why screenshots, not the platform APIs

Instagram Graph API access to private insights needs Meta App Review approval
for `instagram_manage_insights`, plus every creator holding a Business/Creator
account linked to a Facebook Page. TikTok gates the equivalent. Both are
multi-week approvals, and scraping breaches both platforms' terms.

So Phase 1 is creator-submitted screenshots read by Claude vision. The creator
opens their own Insights panel, screenshots it, uploads it. We extract the
numbers and keep the image as an immutable audit record.

Phase 2 adds OAuth as an upgrade path. `Post.metricSource` already discriminates
`screenshot | instagram_oauth | tiktok_oauth | manual`, so an OAuth adapter
drops in behind the same ingestion interface and historical screenshot rows stay
valid and comparable.

## Layout

```
shared/    types, zod validators, metric definitions, plausibility rules
server/    Express API, Mongoose models, extraction pipeline, seed
web/       React + Vite client (three surfaces)     — not yet built
```

`shared` holds every rule that both the API and the UI must agree on. The
plausibility rules and the engagement-rate formula live there as pure functions
so the number the operator sees flagged and the number the brand report prints
are provably the same number.

## Running it

```bash
npm install
cp .env.example .env
npm run db:reset       # seeds 56 creators, 2 campaigns, 34 posts
```

No MongoDB installation needed in development: `connectDb()` boots an in-process
server via `mongodb-memory-server`, persisted at `.mongo-data`. The first run
downloads a MongoDB binary (~66 MB) and needs network access. Set `MONGODB_URI`
to use Atlas instead.

```bash
npm test               # 83 shared + 177 server = 260 tests
npm run typecheck
```

## Build order — all seven done

1. Schemas, types, zod validators, seed
2. Creator magic-link flow, consent capture, screenshot upload
3. Extraction pipeline with confidence routing and plausibility rules
4. Operator verification queue
5. Campaign and roster management
6. Brand share view
7. Nudge and export tooling

## Three surfaces

| Surface | Path | Auth |
| --- | --- | --- |
| Creator | `/c/:token` | Magic link exchanged once for an httpOnly session cookie |
| Operator | `/ops` | Email + password (Argon2id) + mandatory TOTP |
| Brand report | `/r/:token` | Share token, mandatory expiry, optional email gate |

The operator has five tabs: **Queue** (keyboard-driven review), **Roster**
(median engagement, bulk invite), **Nudges**, **Campaigns** (benchmark + brand
share links), and **Data** (export + retention purge, both behind a fresh
password check).

Sign in as the operator with the credentials the seed prints. Creator links
expire in 15 minutes and work once, so mint a fresh one:

```bash
npm run mint --workspace @anton/server
```

## Scheduled work

```bash
npm run extract --workspace @anton/server        # drain pending extractions
npm run purge --workspace @anton/server          # retention dry run
npm run purge --workspace @anton/server -- --apply
```

`extract` needs `ANTHROPIC_API_KEY` and refuses to start without it. `purge` is
a dry run unless you pass `--apply`.

## Security posture

- Magic links: 15-minute TTL, single-use, exchanged for an httpOnly cookie.
  There is no durable credential in JavaScript.
- Operator: Argon2id at the OWASP floor, TOTP mandatory with no grace period,
  8-hour sessions, fresh password check before bulk export or deletion.
- Uploads: server-generated keys only, magic-byte validation, EXIF recorded then
  stripped, 5-minute presign, 60-second read URLs, per-creator and global caps.
- The extraction prompt treats the image as data and never as instructions; a
  detection sets `instruction_text_detected`, blocks auto-accept, and alerts.
- Every operator action is in an append-only audit log with no update path.
- Retention is enforced by [purge.ts](server/src/retention/purge.ts), not just
  promised in a document.

See [BREACH.md](BREACH.md) for the incident procedure and
[BRAND-DATA-TERMS.md](BRAND-DATA-TERMS.md) for the clauses to put in a brand
agreement before issuing a share link.

## The rules that matter

**Nothing is silently corrected.** A metric that fails a plausibility rule is
flagged with a reason and routed to a human. It is never rewritten.

**Every correction is appended, never overwritten.** `Post.manualOverrides` is
an append-only array of `{field, from, to, by, at, reason}`.

**Null is not zero.** A metric we did not capture is `null` and renders as "not
captured". Zero is a real value and stays distinguishable from absence.

**No modelled conversions, anywhere.** Discount-code redemptions and revenue are
only ever figures the brand reported to us, with the source noted. Absent that,
the report says reach and engagement and states plainly that conversion tracking
requires code or link adoption.

**The mega-influencer comparison is a benchmark you typed in.** It carries the
label and source note you entered, and the report says so next to the number.

**Money is integer minor units.** Never a float. `{amountMinor: 4500, currency:
'GBP'}` is £45.00.

## Deviations from the original brief

Three, each deliberate and each flagged in the source at the point it matters:

1. **`followerCount` is a dated series, not one pair.** The `reach > followers ×
   50` rule has to compare against the follower count *as it was when the post
   went live*. One overwritten pair silently re-scores every historical post
   each time you refresh a creator's followers.

2. **`manualOverrides` is an array, not a keyed Record.** A Record keyed by field
   name loses the first correction when a field is corrected twice. Given the
   entire proposition is traceability, that is a hole. `overridesByField()`
   reproduces the Record shape for any UI that wants it.

3. **`costPerThousandEngagements`, not "cost per thousand engaged reach".**
   Neither platform exposes how many of the people reached actually engaged, so
   "engaged reach" is not a computable quantity. The function computes cost per
   thousand *engagements* and labels itself as such. If you want the report to
   say "engaged reach", we need an agreed proxy, labelled as a proxy.

Four collections the brief did not enumerate but the three surfaces need:
`Brand`, `Operator`, `MagicLink`, `ShareLink`.

## Consent

[CONSENT.md](CONSENT.md) is written to be pasted into the creator WhatsApp
community as-is. Its exact bytes are hashed and pinned onto every consent record,
so editing it later cannot retroactively change what someone agreed to.

CONSENT.md is kept strictly creator-facing — no internal notes — because it is
served verbatim into the consent gate and its exact bytes are what gets hashed.
Anything addressed to you belongs here instead.

**Two figures in it need your confirmation before real creators see them.** Both
are defensible defaults I chose, not legal advice:

- **24-month data retention** for profiles, metrics and screenshots. A round
  number that outlasts a typical campaign reporting cycle.
- **6-year consent retention**, outliving the data it covers. Mirrors the
  standard UK contractual limitation period, on the reasoning that the evidence
  we were permitted to hold something should outlive the thing itself.
