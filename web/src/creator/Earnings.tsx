import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Badge, Button, Card, Icon, Notice, Spinner } from '../ui/primitives.jsx';

/**
 * What a creator is owed.
 *
 * The design problem on this screen is that a number next to a currency symbol
 * looks like a wallet. It is not one — Anton computes what is owed and the
 * brand pays directly — so the page says so before it shows a figure, not in a
 * footnote underneath it.
 *
 * Every line can be expanded to its arithmetic. A creator who cannot check a
 * number cannot argue with it, and the entire product rests on these numbers
 * surviving an argument.
 */

interface Money {
  amountMinor: number;
  currency: string;
}

interface Line {
  id: string;
  type: 'accrual' | 'reversal' | 'adjustment';
  occurredAt: string;
  orderedAt: string | null;
  orderValue: Money | null;
  basisAmount: Money;
  amount: Money;
  amountFormatted: string;
  ratePercent: number;
  rateBasis: string;
  workings: string | null;
  reason: string | null;
  attributionMethod: string | null;
  attributionConfidence: 'direct' | 'inferred' | null;
}

interface CampaignEarnings {
  campaignId: string;
  campaignName: string;
  brandName: string | null;
  earned: Money | null;
  earnedByCurrency: Money[];
  paid: Money | null;
  outstanding: Money | null;
  outstandingFormatted: string | null;
  unavailableReason: string | null;
  orderCount: number;
  reversalCount: number;
  lines: Line[];
  payments: {
    amount: Money;
    amountFormatted: string;
    paidAt: string;
    method: string | null;
    reference: string | null;
  }[];
}

interface EarningsResponse {
  campaigns: CampaignEarnings[];
  howThisWorks: {
    whoPays: string;
    antonHoldsNothing: string;
    whenFiguresChange: string;
  };
}

interface TrackingAsset {
  id: string;
  campaignName: string;
  type: 'discount_code' | 'tracked_link';
  value: string;
  shortCode: string | null;
  activeUntil: string | null;
  status: string;
  commissionRatePercent: number;
  commissionRateBasis: string;
}

function money(m: Money | null): string {
  if (!m) return '—';
  const major = m.amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: 2,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${m.currency}`;
  }
}

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function Earnings(): ReactNode {
  const [data, setData] = useState<EarningsResponse | null>(null);
  const [assets, setAssets] = useState<TrackingAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [earnings, tracking] = await Promise.all([
          api.get<EarningsResponse>('/api/creator/earnings'),
          api.get<{ assets: TrackingAsset[] }>('/api/creator/tracking'),
        ]);
        if (cancelled) return;
        setData(earnings);
        setAssets(tracking.assets);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load your earnings.');
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Notice tone="danger" title="Could not load">{error}</Notice>;
  if (!data || !assets) return <Spinner label="Working out your earnings…" />;

  const toggle = (id: string): void => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const nothingYet = data.campaigns.length === 0;

  return (
    <div className="space-y-5">
      {/*
        Said first, before any figure. A number that looks like a balance and
        is not one is the single most likely thing to be misread here.
      */}
      <Notice tone="info" title="How this works">
        <p>{data.howThisWorks.whoPays}</p>
        <p className="mt-1.5">{data.howThisWorks.antonHoldsNothing}</p>
      </Notice>

      {nothingYet ? (
        <Card>
          <p className="font-medium">Nothing yet.</p>
          <p className="mt-1 text-label text-muted">
            Earnings appear here once the brand sends us their orders and we match them to
            your code or link. That usually happens a few days after a post goes out.
          </p>
        </Card>
      ) : null}

      {data.campaigns.map((campaign) => (
        <Card key={campaign.campaignId} className="space-y-4">
          <div>
            <p className="text-label text-muted">{campaign.brandName ?? 'Brand'}</p>
            <h2 className="text-heading font-semibold tracking-tight">{campaign.campaignName}</h2>
          </div>

          {campaign.unavailableReason ? (
            <Notice tone="warn" title="No single total">
              {campaign.unavailableReason}
              <ul className="mt-2 space-y-0.5">
                {campaign.earnedByCurrency.map((m) => (
                  <li key={m.currency} className="tnum">
                    {money(m)}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Figure label="Earned" value={money(campaign.earned)} />
              <Figure label="Paid" value={money(campaign.paid)} />
              <Figure label="Still owed" value={money(campaign.outstanding)} emphasis />
            </div>
          )}

          <p className="text-caption text-muted">
            {campaign.orderCount} {campaign.orderCount === 1 ? 'order' : 'orders'} matched to you
            {campaign.reversalCount > 0
              ? ` · ${campaign.reversalCount} ${campaign.reversalCount === 1 ? 'refund' : 'refunds'}`
              : ''}
          </p>

          {/* ---- the lines */}

          <div className="divide-y divide-line border-t border-line">
            {campaign.lines.map((line) => {
              const expanded = open.has(line.id);
              const negative = line.amount.amountMinor < 0;
              return (
                <div key={line.id}>
                  <button
                    onClick={() => toggle(line.id)}
                    aria-expanded={expanded}
                    className="flex w-full items-center justify-between gap-3 py-3 text-left"
                  >
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">
                          {line.type === 'accrual'
                            ? `Order on ${shortDate(line.orderedAt)}`
                            : line.type === 'reversal'
                              ? 'Refund'
                              : 'Adjustment'}
                        </span>
                        {line.type === 'reversal' ? <Badge tone="warn">came back</Badge> : null}
                        {line.type === 'adjustment' ? <Badge tone="accent">by hand</Badge> : null}
                      </span>
                      {/*
                        The rate is shown against the figure it was applied to,
                        not against the order total. When the two differ —
                        shipping on a subtotal-based rate — showing the total
                        beside "10%" puts a sum on the page that does not add up.
                      */}
                      <span className="mt-0.5 block truncate text-caption text-muted">
                        {line.type === 'accrual'
                          ? `${line.ratePercent}% of ${money(line.basisAmount)} ${line.rateBasis}`
                          : line.type === 'reversal'
                            ? 'Commission returned'
                            : 'Added by the Anton team'}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <span
                        className={`tnum font-semibold ${negative ? 'text-warn' : 'text-ink'}`}
                      >
                        {money(line.amount)}
                      </span>
                      <span
                        className={`text-muted transition-transform ${expanded ? 'rotate-90' : ''}`}
                        aria-hidden="true"
                      >
                        <Icon.chevron />
                      </span>
                    </span>
                  </button>

                  {expanded ? (
                    <div className="pb-4 text-label">
                      <dl className="space-y-1.5 rounded-[--radius-md] bg-sunken p-3">
                        {line.attributionMethod ? (
                          <Row label="Why this is yours">
                            {line.attributionMethod}
                            {line.attributionConfidence === 'inferred' ? (
                              <span className="ml-1.5 text-caption text-muted">
                                (inferred from a click, not a code)
                              </span>
                            ) : null}
                          </Row>
                        ) : null}
                        {line.orderValue ? (
                          <Row label="Order value">
                            {money(line.orderValue)}
                            {line.orderValue.amountMinor !== line.basisAmount.amountMinor ? (
                              <span className="ml-1.5 text-caption text-muted">
                                (includes shipping and anything else outside the {line.rateBasis})
                              </span>
                            ) : null}
                          </Row>
                        ) : null}
                        {line.type === 'accrual' ? (
                          <Row label={`The ${line.rateBasis}`}>{money(line.basisAmount)}</Row>
                        ) : null}
                        <Row label="Your rate">
                          {line.ratePercent}% of the {line.rateBasis}
                        </Row>
                        {/* The arithmetic, verbatim from the ledger entry. */}
                        {line.workings ? (
                          <Row label="Working">
                            <code className="tnum text-caption">{line.workings}</code>
                          </Row>
                        ) : null}
                        {line.reason ? <Row label="Note">{line.reason}</Row> : null}
                        <Row label="Recorded">{shortDate(line.occurredAt)}</Row>
                      </dl>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {campaign.payments.length > 0 ? (
            <div>
              <p className="mb-1.5 text-label font-medium">Payments the brand has recorded</p>
              <ul className="space-y-1">
                {campaign.payments.map((p, i) => (
                  <li key={i} className="flex justify-between text-label">
                    <span className="text-muted">
                      {shortDate(p.paidAt)}
                      {p.method ? ` · ${p.method}` : ''}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </span>
                    <span className="tnum font-medium">{money(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ))}

      {/* ---- the creator's own codes */}

      {assets.length > 0 ? (
        <Card className="space-y-3">
          <h2 className="text-heading font-semibold tracking-tight">Your codes and links</h2>
          <p className="text-label text-muted">
            These are what we match orders against. If one is missing or wrong, tell us before
            you post.
          </p>
          <ul className="divide-y divide-line border-t border-line">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-label font-medium">
                    {a.type === 'discount_code' ? a.value : (a.shortCode ?? a.value)}
                  </p>
                  <p className="truncate text-caption text-muted">
                    {a.campaignName} · {a.commissionRatePercent}% of {a.commissionRateBasis}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {a.status !== 'active' ? <Badge tone="danger">{a.status}</Badge> : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void navigator.clipboard?.writeText(
                        a.type === 'discount_code' ? a.value : (a.shortCode ?? a.value),
                      );
                    }}
                  >
                    Copy
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {!nothingYet ? (
        <>
          <Notice tone="info">{data.howThisWorks.whenFiguresChange}</Notice>
          {/*
            A normal link, not a fetch: the browser handles the download and
            the session cookie rides along, so nothing has to hold the file in
            memory on a phone.
          */}
          <a
            href="/api/creator/earnings/statement.csv"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[--radius-md] border border-line text-label font-medium hover:bg-sunken"
          >
            Download a statement
            <span aria-hidden="true">
              <Icon.external />
            </span>
          </a>
        </>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): ReactNode {
  return (
    <div
      className={`rounded-[--radius-md] border p-3 ${
        emphasis ? 'border-accent-line bg-accent-soft' : 'border-line'
      }`}
    >
      <p className="text-caption text-muted">{label}</p>
      <p className={`tnum mt-1 text-heading font-semibold ${emphasis ? 'text-accent-ink' : ''}`}>
        {value}
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
