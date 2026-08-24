import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import { Button, Card, Notice, Spinner, inputClass } from '../ui/primitives.jsx';

/* Types mirror the /api/report payload rather than the database. */

interface Figure {
  value: number | null;
  basis: string;
  unavailableReason: string | null;
}

interface ReportPayload {
  gated: boolean;
  message?: string;
  brand: { name: string; primaryColorHex: string | null } | null;
  campaign: { name: string; objective: string; startDate: string; endDate: string; currency: string };
  summary: {
    creatorsActivated: number;
    postsLive: number;
    totalReach: Figure;
    totalImpressions: Figure;
    totalEngagements: Figure;
    spend: { amountMinor: number; currency: string };
    costPerThousandReach: Figure;
    costPerThousandEngagements: Figure;
    coverage: { included: number; excludedNotVerified: number; excludedRejected: number };
  };
  comparison: {
    label: string;
    sourceNote: string;
    quotedFee: { amountMinor: number; currency: string };
    quotedReach: number;
    benchmarkCostPerThousandReach: number;
    campaignCostPerThousandReach: number | null;
    ratio: number | null;
  } | null;
  creators: {
    creatorId: string;
    displayName: string;
    handle: string | null;
    nicheTags: string[];
    followerBand: string;
    followers: number | null;
    agreedRate: { amountMinor: number; currency: string } | null;
    totalReach: number | null;
    totalEngagements: number | null;
    posts: {
      postId: string;
      format: string;
      platform: string;
      postedAt: string;
      publicUrl: string | null;
      metrics: Record<string, number | null>;
      engagementRate: number | null;
      engagements: number | null;
      hookText: string | null;
      provenance: { label: string; detail: string; isPlatformVerified: boolean };
      sourceScreenshotUrl: string | null;
      sourceImageSha256: string | null;
      verifiedAt: string | null;
    }[];
  }[];
  breakdowns: {
    byCreativeAngle: GroupRow[];
    byFormat: GroupRow[];
    byNiche: GroupRow[];
  };
  topHooks: { hookText: string; postId: string; engagementRate: number | null; reach: number | null }[];
  conversions: {
    reportedRedemptions: number | null;
    reportedRevenue: { amountMinor: number; currency: string } | null;
    reportedBySource: string | null;
    codesIssued: number;
    codesWithData: number;
    statement: string;
  };
  methodology: {
    provenance: string;
    verificationLimit: string;
    exclusions: string;
    spend: string;
  };
  link: { expiresAt: string; showsCompensation: boolean };
}

interface GroupRow {
  key: string;
  posts: number;
  totalReach: number | null;
  totalEngagements: number | null;
  medianEngagementRate: number | null;
}

function money(m: { amountMinor: number; currency: string } | null): string {
  if (!m) return '—';
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  return `${symbols[m.currency] ?? m.currency + ' '}${(m.amountMinor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pence(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  return `${symbols[currency] ?? currency + ' '}${(minor / 100).toFixed(2)}`;
}

export function ReportApp(): ReactNode {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const load = useCallback(
    async (withEmail?: string): Promise<void> => {
      if (!token) return;
      try {
        const query = withEmail ? `?email=${encodeURIComponent(withEmail)}` : '';
        setData(await api.get<ReportPayload>(`/api/report/${token}${query}`));
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not open this report.');
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="mx-auto w-full max-w-lg px-6 py-20">
        <Notice tone="warn" title="Cannot open this report">
          {error}
        </Notice>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto flex w-full max-w-lg px-6 py-20">
        <Spinner label="Opening the report…" />
      </main>
    );
  }

  if (data.gated) {
    return <EmailGate token={token ?? ''} message={data.message ?? ''} onVerified={(e) => void load(e)} />;
  }

  const s = data.summary;
  const currency = data.campaign.currency;

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-10">
        <p className="text-sm text-muted">{data.brand?.name ?? 'Campaign report'}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">{data.campaign.name}</h1>
        <p className="mt-2 text-muted">
          {new Date(data.campaign.startDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          {' – '}
          {new Date(data.campaign.endDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
          {data.campaign.objective ? ` · ${data.campaign.objective}` : ''}
        </p>
      </header>

      {/* --------------------------------------------------------- headline */}
      <section className="mb-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Creators activated" value={s.creatorsActivated.toLocaleString()} />
        <Stat label="Posts live" value={s.postsLive.toLocaleString()} />
        <Stat
          label="Total reach"
          value={s.totalReach.value?.toLocaleString() ?? null}
          unavailable={s.totalReach.unavailableReason}
        />
        <Stat
          label="Total engagements"
          value={s.totalEngagements.value?.toLocaleString() ?? null}
          unavailable={s.totalEngagements.unavailableReason}
          footnote={s.totalEngagements.basis}
        />
      </section>

      <section className="mb-10 grid gap-4 sm:grid-cols-3">
        <Stat label="Spend" value={money(s.spend)} footnote={data.methodology.spend} />
        <Stat
          label="Cost per 1,000 reach"
          value={s.costPerThousandReach.value !== null ? pence(s.costPerThousandReach.value, currency) : null}
          unavailable={s.costPerThousandReach.unavailableReason}
        />
        <Stat
          label="Cost per 1,000 engagements"
          value={
            s.costPerThousandEngagements.value !== null
              ? pence(s.costPerThousandEngagements.value, currency)
              : null
          }
          unavailable={s.costPerThousandEngagements.unavailableReason}
          footnote="Engagements, not “engaged reach”: neither platform reports how many of the people reached engaged."
        />
      </section>

      {/* ------------------------------------------------------- comparison */}
      {data.comparison ? (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Against a single large creator</h2>
          <Card>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="text-sm text-muted">This campaign</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {pence(data.comparison.campaignCostPerThousandReach, currency)}
                </p>
                <p className="text-sm text-muted">per 1,000 reach</p>
              </div>
              <div>
                <p className="text-sm text-muted">{data.comparison.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {pence(data.comparison.benchmarkCostPerThousandReach, currency)}
                </p>
                <p className="text-sm text-muted">
                  per 1,000 reach · {money(data.comparison.quotedFee)} for{' '}
                  {data.comparison.quotedReach.toLocaleString()} reach
                </p>
              </div>
            </div>

            {data.comparison.ratio !== null ? (
              <p className="mt-5 border-t border-line pt-4 text-lg">
                {data.comparison.ratio >= 1 ? (
                  <>
                    This campaign reached people{' '}
                    <span className="font-semibold text-accent">
                      {data.comparison.ratio.toFixed(1)}× more cheaply
                    </span>
                    .
                  </>
                ) : (
                  <>
                    This campaign was{' '}
                    <span className="font-semibold text-warn">
                      {(1 / data.comparison.ratio).toFixed(1)}× more expensive
                    </span>{' '}
                    per 1,000 reach.
                  </>
                )}
              </p>
            ) : null}

            <Notice tone="warn">
              <span className="font-semibold">This comparison figure was supplied by Anton, not measured.</span>{' '}
              {data.comparison.sourceNote} It is a quoted rate for a hypothetical
              alternative buy, not the result of a campaign that ran.
            </Notice>
          </Card>
        </section>
      ) : null}

      {/* -------------------------------------------------------- creators */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Every creator, every post</h2>
        <p className="mb-3 text-sm text-muted">
          Expand a row to see the screenshot each number came from.
        </p>
        <div className="space-y-2">
          {data.creators
            .filter((c) => c.posts.length > 0)
            .sort((a, b) => (b.totalReach ?? 0) - (a.totalReach ?? 0))
            .map((c) => (
              <details key={c.creatorId} className="rounded-xl border border-line">
                <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span>
                    <span className="font-medium">{c.displayName}</span>
                    {c.handle ? <span className="text-muted"> @{c.handle}</span> : null}
                    <span className="ml-2 text-xs text-muted">
                      {c.nicheTags.join(', ')}
                      {c.followers ? ` · ${c.followers.toLocaleString()} followers` : ` · ${c.followerBand}`}
                    </span>
                  </span>
                  <span className="text-sm tabular-nums text-muted">
                    {c.totalReach?.toLocaleString() ?? '—'} reach ·{' '}
                    {c.totalEngagements?.toLocaleString() ?? '—'} engagements
                    {c.agreedRate ? ` · ${money(c.agreedRate)}` : ''}
                  </span>
                </summary>

                <div className="space-y-4 border-t border-line px-4 py-4">
                  {c.posts.map((p) => (
                    <div key={p.postId} className="grid gap-4 sm:grid-cols-[10rem_1fr]">
                      {p.sourceScreenshotUrl ? (
                        <a href={p.sourceScreenshotUrl} target="_blank" rel="noreferrer noopener">
                          <img
                            src={p.sourceScreenshotUrl}
                            alt="The Insights screenshot these numbers were read from"
                            className="w-full rounded-lg border border-line"
                          />
                        </a>
                      ) : (
                        <div className="rounded-lg border border-line p-3 text-xs text-muted">
                          No source image
                        </div>
                      )}
                      <div>
                        <p className="text-sm font-medium">
                          {p.format} · {new Date(p.postedAt).toLocaleDateString()}
                          {p.publicUrl ? (
                            <>
                              {' · '}
                              <a className="underline" href={p.publicUrl} target="_blank" rel="noreferrer noopener">
                                view post
                              </a>
                            </>
                          ) : null}
                        </p>
                        {p.hookText ? <p className="mt-1 text-sm italic text-muted">“{p.hookText}”</p> : null}
                        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
                          {Object.entries(p.metrics)
                            .filter(([, v]) => v !== null)
                            .map(([k, v]) => (
                              <div key={k} className="flex justify-between gap-2">
                                <dt className="text-muted">{k}</dt>
                                <dd className="tabular-nums">{v?.toLocaleString()}</dd>
                              </div>
                            ))}
                        </dl>
                        <p
                          className={`mt-3 inline-block rounded-full px-3 py-1 text-xs ${
                            p.provenance.isPlatformVerified
                              ? 'bg-accent-soft text-accent'
                              : 'bg-line/40 text-muted'
                          }`}
                          title={p.provenance.detail}
                        >
                          {p.provenance.label}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
        </div>
      </section>

      {/* ------------------------------------------------------ breakdowns */}
      <section className="mb-10 grid gap-6 lg:grid-cols-3">
        <Breakdown title="By creative angle" rows={data.breakdowns.byCreativeAngle} />
        <Breakdown title="By format" rows={data.breakdowns.byFormat} />
        <Breakdown title="By audience niche" rows={data.breakdowns.byNiche} />
      </section>

      {data.topHooks.length > 0 ? (
        <section className="mb-10">
          <h2 className="mb-3 text-lg font-semibold">Hooks that worked hardest</h2>
          <ol className="space-y-2">
            {data.topHooks.map((h) => (
              <li key={h.postId} className="flex justify-between gap-4 rounded-xl border border-line px-4 py-3">
                <span className="italic">“{h.hookText}”</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {h.engagementRate !== null ? `${(h.engagementRate * 100).toFixed(1)}%` : '—'}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ------------------------------------------------------ conversion */}
      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">Sales</h2>
        {data.conversions.reportedRedemptions === null ? (
          <Notice tone="info">{data.conversions.statement}</Notice>
        ) : (
          <Card>
            <div className="grid gap-6 sm:grid-cols-2">
              <Stat label="Code redemptions" value={data.conversions.reportedRedemptions.toLocaleString()} />
              <Stat label="Revenue" value={money(data.conversions.reportedRevenue)} />
            </div>
            <p className="mt-4 text-sm text-muted">{data.conversions.statement}</p>
            {data.conversions.reportedBySource ? (
              <p className="mt-1 text-xs text-muted">Source: {data.conversions.reportedBySource}</p>
            ) : null}
          </Card>
        )}
      </section>

      {/* ----------------------------------------------------- methodology */}
      <section className="border-t border-line pt-6">
        <h2 className="mb-3 text-lg font-semibold">How to read these numbers</h2>
        <div className="space-y-3 text-sm text-muted">
          <p>{data.methodology.provenance}</p>
          <p>{data.methodology.verificationLimit}</p>
          <p>{data.methodology.exclusions}</p>
          <p>{data.methodology.spend}</p>
        </div>
        <p className="mt-6 text-xs text-muted">
          This link expires {new Date(data.link.expiresAt).toLocaleDateString()}. Please do not
          forward it — ask Anton for a link of your own.
        </p>
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  unavailable,
  footnote,
}: {
  label: string;
  value: string | null;
  unavailable?: string | null;
  footnote?: string;
}): ReactNode {
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-sm text-muted">{label}</p>
      {value !== null ? (
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      ) : (
        <p className="mt-1 text-lg text-muted" title={unavailable ?? undefined}>
          not captured
        </p>
      )}
      {footnote ? <p className="mt-1 text-xs text-muted">{footnote}</p> : null}
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: GroupRow[] }): ReactNode {
  return (
    <div>
      <h3 className="mb-2 font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">Nothing recorded.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          {rows.map((r) => (
            <div key={r.key} className="flex justify-between gap-3 border-b border-line/60 px-3 py-2 text-sm last:border-0">
              <span className="truncate">{r.key.replace(/[-_]/g, ' ')}</span>
              <span className="shrink-0 tabular-nums text-muted">
                {r.medianEngagementRate !== null ? `${(r.medianEngagementRate * 100).toFixed(1)}%` : '—'}
                <span className="ml-2 text-xs">({r.posts})</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="mt-1 text-xs text-muted">Median engagement rate, post count in brackets.</p>
    </div>
  );
}

function EmailGate({
  token,
  message,
  onVerified,
}: {
  token: string;
  message: string;
  onVerified: (email: string) => void;
}): ReactNode {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/report/${token}/request-code`, { email });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/report/${token}/verify-code`, { email, code });
      onVerified(email);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work.');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-20">
      <h1 className="text-xl font-semibold tracking-tight">Campaign report</h1>
      <p className="mt-2 text-sm text-muted">{message}</p>

      <div className="mt-6 space-y-3">
        <input
          className={inputClass}
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={sent}
        />
        {sent ? (
          <input
            className={`${inputClass} tabular-nums tracking-widest`}
            inputMode="numeric"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button
          className="w-full"
          disabled={busy || (sent ? code.length !== 6 : email.length < 5)}
          onClick={() => void (sent ? verify() : requestCode())}
        >
          {busy ? 'Working…' : sent ? 'Open the report' : 'Send me a code'}
        </Button>
      </div>

      <p className="mt-6 text-xs text-muted">
        We record which address opened this report and when.
      </p>
    </main>
  );
}
