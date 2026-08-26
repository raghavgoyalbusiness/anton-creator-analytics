import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api.js';
import {
  Badge,
  Button,
  Card,
  Icon,
  Notice,
  SectionHeading,
  Spinner,
  Stat,
  inputClass,
} from '../ui/primitives.jsx';
import { BarSeries, ComparisonBars, CoverageBar, InlineBar } from '../ui/charts.jsx';

/* Types mirror the /api/report payload rather than the database. */

interface Figure {
  value: number | null;
  basis: string;
  unavailableReason: string | null;
}

interface GroupRow {
  key: string;
  posts: number;
  totalReach: number | null;
  totalEngagements: number | null;
  medianEngagementRate: number | null;
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
  breakdowns: { byCreativeAngle: GroupRow[]; byFormat: GroupRow[]; byNiche: GroupRow[] };
  topHooks: { hookText: string; postId: string; engagementRate: number | null; reach: number | null }[];
  conversions: {
    reportedRedemptions: number | null;
    reportedRevenue: { amountMinor: number; currency: string } | null;
    reportedBySource: string | null;
    codesIssued: number;
    codesWithData: number;
    statement: string;
  };
  methodology: { provenance: string; verificationLimit: string; exclusions: string; spend: string };
  link: { expiresAt: string; showsCompensation: boolean };
}

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };

function money(m: { amountMinor: number; currency: string } | null): string {
  if (!m) return '—';
  return `${SYMBOLS[m.currency] ?? m.currency + ' '}${(m.amountMinor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pence(minor: number | null, currency: string): string {
  if (minor === null) return '—';
  return `${SYMBOLS[currency] ?? currency + ' '}${(minor / 100).toFixed(2)}`;
}

const METRIC_LABELS: Record<string, string> = {
  reach: 'Reach',
  impressions: 'Impressions',
  likes: 'Likes',
  comments: 'Comments',
  shares: 'Shares',
  saves: 'Saves',
  profileVisits: 'Profile visits',
  linkClicks: 'Link clicks',
  videoViews: 'Video views',
  watchTimeSeconds: 'Watch time',
  followsFromPost: 'New follows',
};

export function ReportApp(): ReactNode {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ReportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <main className="mx-auto w-full max-w-lg px-6 py-24">
        <Notice tone="warn" title="Cannot open this report">
          {error}
        </Notice>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto flex w-full max-w-lg px-6 py-24">
        <Spinner label="Opening the report…" />
      </main>
    );
  }

  if (data.gated) {
    return <EmailGate token={token ?? ''} message={data.message ?? ''} onVerified={(e) => void load(e)} />;
  }

  const s = data.summary;
  const currency = data.campaign.currency;
  const dateFmt: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' };

  return (
    <main className="mx-auto w-full max-w-5xl px-6 pb-24 pt-12">
      {/* ------------------------------------------------------------ head */}
      <header className="mb-12">
        <p className="text-label font-medium uppercase tracking-widest text-muted">
          {data.brand?.name ?? 'Campaign report'}
        </p>
        <h1 className="mt-2 text-display font-semibold">{data.campaign.name}</h1>
        <p className="mt-3 text-body text-ink-secondary">
          {new Date(data.campaign.startDate).toLocaleDateString(undefined, dateFmt)} –{' '}
          {new Date(data.campaign.endDate).toLocaleDateString(undefined, {
            ...dateFmt,
            year: 'numeric',
          })}
          {data.campaign.objective ? ` · ${data.campaign.objective}` : ''}
        </p>
      </header>

      {/* -------------------------------------------------------- headline */}
      {data.comparison && data.comparison.ratio !== null ? (
        <section className="mb-12">
          <Card className="overflow-hidden !p-0">
            <div className="border-b border-line bg-accent-soft px-6 py-8 sm:px-8">
              <p className="text-label font-medium uppercase tracking-widest text-accent-ink opacity-80">
                Cost per 1,000 people reached
              </p>
              <p className="mt-3 text-display font-semibold text-accent-ink">
                {data.comparison.ratio >= 1
                  ? `${data.comparison.ratio.toFixed(1)}× cheaper`
                  : `${(1 / data.comparison.ratio).toFixed(1)}× dearer`}
              </p>
              <p className="mt-2 max-w-xl text-body text-accent-ink opacity-90">
                than the single large creator this campaign was weighed against.
              </p>
            </div>

            <div className="px-6 py-7 sm:px-8">
              <ComparisonBars
                rows={[
                  {
                    label: 'This campaign',
                    value: data.comparison.campaignCostPerThousandReach ?? 0,
                    display: pence(data.comparison.campaignCostPerThousandReach, currency),
                    isFigure: true,
                    caption: `${s.creatorsActivated} creators · ${money(s.spend)} · ${
                      s.totalReach.value?.toLocaleString() ?? '—'
                    } reach`,
                  },
                  {
                    label: data.comparison.label,
                    value: data.comparison.benchmarkCostPerThousandReach,
                    display: pence(data.comparison.benchmarkCostPerThousandReach, currency),
                    isFigure: false,
                    caption: `${money(data.comparison.quotedFee)} quoted for ${data.comparison.quotedReach.toLocaleString()} reach`,
                  },
                ]}
                caption="Shorter is better — this is a cost, so the campaign wins by spending less to reach the same thousand people."
              />

              <div className="mt-6">
                <Notice tone="warn" title="The comparison figure was supplied by Anton, not measured">
                  {data.comparison.sourceNote} It is a quoted rate for a buy that did not happen,
                  set against a campaign that did.
                </Notice>
              </div>
            </div>
          </Card>
        </section>
      ) : null}

      {/* --------------------------------------------------------- summary */}
      <section className="mb-12">
        <SectionHeading title="What ran" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Creators activated" value={s.creatorsActivated.toLocaleString()} />
          <Stat label="Posts live" value={s.postsLive.toLocaleString()} />
          <Stat
            label="People reached"
            value={s.totalReach.value?.toLocaleString() ?? null}
            unavailable={s.totalReach.unavailableReason}
          />
          <Stat
            label="Engagements"
            value={s.totalEngagements.value?.toLocaleString() ?? null}
            unavailable={s.totalEngagements.unavailableReason}
            footnote="Likes, comments, shares and saves"
          />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Stat label="Spend" value={money(s.spend)} footnote="Agreed with the creators who took part" />
          <Stat
            label="Per 1,000 reach"
            value={s.costPerThousandReach.value !== null ? pence(s.costPerThousandReach.value, currency) : null}
            unavailable={s.costPerThousandReach.unavailableReason}
            emphasis
          />
          <Stat
            label="Per 1,000 engagements"
            value={
              s.costPerThousandEngagements.value !== null
                ? pence(s.costPerThousandEngagements.value, currency)
                : null
            }
            unavailable={s.costPerThousandEngagements.unavailableReason}
            footnote="Engagements, not “engaged reach” — neither platform reports how many of those reached engaged"
          />
        </div>

        <Card className="mt-3">
          <p className="mb-3 text-label font-medium">What is counted</p>
          <CoverageBar
            segments={[
              { key: 'in', label: 'included', count: s.coverage.included, tone: 'figure' },
              { key: 'checking', label: 'still being checked', count: s.coverage.excludedNotVerified, tone: 'warn' },
              { key: 'rejected', label: 'rejected', count: s.coverage.excludedRejected, tone: 'ground' },
            ]}
          />
          <p className="mt-3 text-caption text-muted">
            Posts still being checked are not counted as zero. They are simply not yet
            established, and will appear here once they are.
          </p>
        </Card>
      </section>

      {/* -------------------------------------------------------- creators */}
      <section className="mb-12">
        <SectionHeading
          title="Every creator, every post"
          hint="Expand a row to see the screenshot each number was read from."
        />
        <div className="space-y-2">
          {data.creators
            .filter((c) => c.posts.length > 0)
            .sort((a, b) => (b.totalReach ?? 0) - (a.totalReach ?? 0))
            .map((c, _i, all) => {
              const topReach = all[0]?.totalReach ?? 1;
              return (
                <details
                  key={c.creatorId}
                  className="group overflow-hidden rounded-[--radius-lg] border border-line bg-surface"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-4 px-4 py-3.5 hover:bg-sunken">
                    <span className="text-muted transition-transform duration-[--duration-fast] group-open:rotate-90">
                      <Icon.chevron />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {c.displayName}
                        {c.handle ? (
                          <span className="ml-1.5 font-normal text-muted">@{c.handle}</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-caption text-muted">
                        {c.nicheTags.join(' · ')}
                        {c.followers
                          ? ` · ${c.followers.toLocaleString()} followers`
                          : ` · ${c.followerBand.replace(/_/g, ' ')}`}
                        {c.agreedRate ? ` · ${money(c.agreedRate)}` : ''}
                      </span>
                    </span>
                    <span className="hidden w-40 shrink-0 sm:block">
                      <span className="tnum block text-right text-label font-medium">
                        {c.totalReach?.toLocaleString() ?? '—'}
                      </span>
                      <InlineBar fraction={(c.totalReach ?? 0) / (topReach || 1)} />
                      <span className="mt-1 block text-right text-caption text-muted">reach</span>
                    </span>
                  </summary>

                  <div className="space-y-5 border-t border-line bg-sunken/50 px-4 py-5">
                    {c.posts.map((p) => (
                      <article key={p.postId} className="grid gap-4 sm:grid-cols-[9rem_1fr]">
                        {p.sourceScreenshotUrl ? (
                          <a
                            href={p.sourceScreenshotUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="block"
                          >
                            <img
                              src={p.sourceScreenshotUrl}
                              alt={`The Insights screenshot ${c.displayName}'s numbers were read from`}
                              className="w-full rounded-[--radius-md] border border-line shadow-[--shadow-raised]"
                            />
                            <span className="mt-1.5 flex items-center gap-1 text-caption text-muted">
                              <Icon.external /> source
                            </span>
                          </a>
                        ) : (
                          <div className="rounded-[--radius-md] border border-dashed border-line p-3 text-caption text-muted">
                            No source image
                          </div>
                        )}

                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge tone={p.provenance.isPlatformVerified ? 'accent' : 'neutral'}>
                              {p.provenance.label}
                            </Badge>
                            <span className="text-caption text-muted">
                              {p.format.replace(/_/g, ' ')} ·{' '}
                              {new Date(p.postedAt).toLocaleDateString(undefined, dateFmt)}
                            </span>
                            {p.publicUrl ? (
                              <a
                                className="flex items-center gap-1 text-caption text-accent-ink underline"
                                href={p.publicUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                              >
                                view post <Icon.external />
                              </a>
                            ) : null}
                          </div>

                          {p.hookText ? (
                            <blockquote className="mt-3 border-l-2 border-accent-line pl-3 text-body italic text-ink-secondary">
                              “{p.hookText}”
                            </blockquote>
                          ) : null}

                          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
                            {Object.entries(p.metrics)
                              .filter(([, v]) => v !== null)
                              .map(([k, v]) => (
                                <div key={k} className="flex items-baseline justify-between gap-2 border-b border-line/70 pb-1">
                                  <dt className="text-caption text-muted">{METRIC_LABELS[k] ?? k}</dt>
                                  <dd className="tnum text-label font-medium">
                                    {v?.toLocaleString()}
                                  </dd>
                                </div>
                              ))}
                          </dl>

                          {p.engagementRate !== null ? (
                            <p className="mt-3 text-caption text-muted">
                              Engagement rate{' '}
                              <span className="tnum font-medium text-ink-secondary">
                                {(p.engagementRate * 100).toFixed(1)}%
                              </span>
                            </p>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                </details>
              );
            })}
        </div>
      </section>

      {/* ------------------------------------------------------ breakdowns */}
      <section className="mb-12">
        <SectionHeading
          title="What worked"
          hint="Median engagement rate, so one viral post cannot crown a category. Post count in brackets."
        />
        <div className="grid gap-4 lg:grid-cols-3">
          {(
            [
              ['Creative angle', data.breakdowns.byCreativeAngle],
              ['Format', data.breakdowns.byFormat],
              ['Audience niche', data.breakdowns.byNiche],
            ] as [string, GroupRow[]][]
          ).map(([title, rows]) => (
            <Card key={title}>
              <p className="mb-3 text-label font-medium">{title}</p>
              <BarSeries
                rows={rows.map((r) => ({
                  key: r.key,
                  label: r.key.replace(/[-_]/g, ' '),
                  value: r.medianEngagementRate,
                  display:
                    r.medianEngagementRate !== null
                      ? `${(r.medianEngagementRate * 100).toFixed(1)}%`
                      : 'not measured',
                  meta: `(${r.posts})`,
                }))}
              />
            </Card>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- hooks */}
      {data.topHooks.length > 0 ? (
        <section className="mb-12">
          <SectionHeading title="Hooks that worked hardest" hint="Opening lines, ranked by engagement rate." />
          <ol className="space-y-2">
            {data.topHooks.map((h, i) => (
              <li
                key={h.postId}
                className="flex items-center gap-4 rounded-[--radius-md] border border-line bg-surface px-4 py-3"
              >
                <span className="tnum w-5 shrink-0 text-label text-muted">{i + 1}</span>
                <span className="min-w-0 flex-1 text-body italic text-ink-secondary">
                  “{h.hookText}”
                </span>
                <span className="tnum shrink-0 text-label font-medium">
                  {h.engagementRate !== null ? `${(h.engagementRate * 100).toFixed(1)}%` : '—'}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* ------------------------------------------------------ conversion */}
      <section className="mb-12">
        <SectionHeading title="Sales" />
        {data.conversions.reportedRedemptions === null ? (
          <Notice tone="info" title="No conversion data">
            {data.conversions.statement}
          </Notice>
        ) : (
          <Card>
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat
                label="Code redemptions"
                value={data.conversions.reportedRedemptions.toLocaleString()}
              />
              <Stat label="Revenue reported" value={money(data.conversions.reportedRevenue)} />
            </div>
            <p className="mt-4 text-label text-muted">{data.conversions.statement}</p>
            {data.conversions.reportedBySource ? (
              <p className="mt-1 text-caption text-muted">
                Source: {data.conversions.reportedBySource}
              </p>
            ) : null}
          </Card>
        )}
      </section>

      {/* ----------------------------------------------------- methodology */}
      <section className="border-t border-line pt-8">
        <SectionHeading title="How to read these numbers" />
        <div className="grid gap-4 sm:grid-cols-2">
          {(
            [
              ['Where they come from', data.methodology.provenance],
              ['What they are not', data.methodology.verificationLimit],
              ['What is counted', data.methodology.exclusions],
              ['What spend means', data.methodology.spend],
            ] as [string, string][]
          ).map(([title, body]) => (
            <div key={title}>
              <p className="text-label font-medium">{title}</p>
              <p className="mt-1 text-label leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 text-caption text-muted">
          This link expires {new Date(data.link.expiresAt).toLocaleDateString()}. Please do not
          forward it — ask Anton for a link of your own, so we can tell you who has seen what.
        </p>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------ email gate */

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
    <main className="mx-auto w-full max-w-sm px-6 py-24">
      <p className="text-label font-medium uppercase tracking-widest text-muted">Anton</p>
      <h1 className="mt-2 text-title font-semibold">Campaign report</h1>
      <p className="mt-2 text-body text-ink-secondary">{message}</p>

      <div className="mt-8 space-y-3">
        <input
          className={inputClass}
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={sent}
        />
        {sent ? (
          <input
            className={`${inputClass} tnum tracking-[0.4em]`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            autoFocus
          />
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button
          className="w-full"
          loading={busy}
          disabled={sent ? code.length !== 6 : email.length < 5}
          onClick={() => void (sent ? verify() : requestCode())}
        >
          {sent ? 'Open the report' : 'Send me a code'}
        </Button>
      </div>

      <p className="mt-6 text-caption text-muted">
        We record which address opened this report and when.
      </p>
    </main>
  );
}
