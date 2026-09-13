import type { ReactNode } from 'react';
import { Badge, Card, Notice, SectionHeading, Stat } from '../ui/primitives.jsx';
import { CoverageBar, InlineBar } from '../ui/charts.jsx';

/**
 * The revenue section of a brand report.
 *
 * This is the part of the report a brand acts on, so it is also the part most
 * worth being careful with. Three things are structural here, not stylistic:
 *
 * The method breakdown is always rendered, never behind a disclosure. A brand
 * that discovers months later that "attributed revenue" was mostly link clicks
 * feels misled, and would be right to.
 *
 * Unattributed orders sit beside attributed ones at the same size. Hiding them
 * would make every other figure on the page look better than it is.
 *
 * The limits of attribution are stated in the section itself, not in a
 * methodology footer nobody scrolls to.
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface MethodShare {
  method: string;
  label: string;
  confidence: 'direct' | 'inferred';
  orders: number;
  revenue: Money;
  shareOfAttributedBps: number;
  explanation: string;
}

export interface RevenueData {
  currency: string;
  ordersSeen: number;
  ordersAttributed: number;
  ordersUnattributed: number;
  coverageBps: number;
  attributedRevenue: Money;
  attributedRevenueNetOfRefunds: Money;
  unattributedRevenue: Money;
  totalRevenueSeen: Money;
  refundedOrders: number;
  refundedValue: Money;
  commissionOwed: Money;
  revenuePerCommissionUnit: number | null;
  averageOrderValue: Money | null;
  newCustomerOrders: number;
  returningCustomerOrders: number;
  unknownCustomerTypeOrders: number;
  byMethod: MethodShare[];
  unattributedReasons: { reason: string; orders: number }[];
  byCreator: {
    creatorId: string;
    displayName: string | null;
    handle: string | null;
    orders: number;
    revenue: Money;
    commission: Money;
    methods: string[];
  }[];
  statements: {
    coverage: string;
    method: string;
    refunds: string;
    causation: string;
  };
  window: { from: string; to: string };
}

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };

function money(m: Money | null): string {
  if (!m) return '—';
  return `${SYMBOLS[m.currency] ?? `${m.currency} `}${(m.amountMinor / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Whole pounds. Pence on a six-figure total are noise on a summary tile. */
function roundMoney(m: Money | null): string {
  if (!m) return '—';
  return `${SYMBOLS[m.currency] ?? `${m.currency} `}${Math.round(m.amountMinor / 100).toLocaleString()}`;
}

function windowDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function pct(bps: number, decimals = 1): string {
  return `${(bps / 100).toFixed(decimals)}%`;
}

export function RevenueSection({
  data,
  showCreators,
}: {
  data: RevenueData;
  showCreators: boolean;
}): ReactNode {
  const nothingSupplied = data.ordersSeen === 0;

  if (nothingSupplied) {
    return (
      <section className="mb-12">
        <SectionHeading title="Revenue" />
        <Notice tone="info" title="No orders supplied">
          {data.statements.coverage} Once you send us an order export, every order carrying a
          creator code or link is matched here — and every order that is not is shown too.
        </Notice>
      </section>
    );
  }

  const hasInferred = data.byMethod.some((m) => m.confidence === 'inferred');

  return (
    <section className="mb-12">
      {/* Same date format as the report header, so the two cannot look like
          different windows. */}
      <SectionHeading
        title="Revenue"
        hint={`Orders placed between ${windowDate(data.window.from)} and ${windowDate(
          data.window.to,
        )}.`}
      />

      {/* ---- headline */}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Revenue matched to a creator"
          value={roundMoney(data.attributedRevenue)}
          footnote={`${data.ordersAttributed.toLocaleString()} orders`}
          size="lg"
          emphasis
        />
        <Stat
          label="After refunds"
          value={roundMoney(data.attributedRevenueNetOfRefunds)}
          footnote={
            data.refundedOrders === 0
              ? 'nothing refunded'
              : `${data.refundedOrders} refunded, ${roundMoney(data.refundedValue)} returned`
          }
        />
        <Stat
          label="Commission owed"
          value={roundMoney(data.commissionOwed)}
          footnote={
            data.revenuePerCommissionUnit === null
              ? 'no commission earned'
              : `${data.revenuePerCommissionUnit.toFixed(1)}× revenue per unit of commission`
          }
        />
        <Stat
          label="Average matched order"
          value={data.averageOrderValue ? money(data.averageOrderValue) : null}
          unavailable="Nothing was matched, so there is no average."
        />
      </div>

      {/* ---- coverage, at the same size as the headline */}

      <Card className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-label font-medium">
            What Anton could account for
          </p>
          <p className="tnum text-label text-muted">
            {pct(data.coverageBps)} of orders in this window
          </p>
        </div>

        <div className="mt-3">
          <CoverageBar
            segments={[
              {
                key: 'attributed',
                label: 'Matched to a creator',
                count: data.ordersAttributed,
                tone: 'figure',
              },
              {
                key: 'unattributed',
                label: 'Not matched',
                count: data.ordersUnattributed,
                tone: 'ground',
              },
            ]}
          />
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-caption text-muted">Matched</p>
            <p className="tnum text-heading font-semibold">{roundMoney(data.attributedRevenue)}</p>
          </div>
          <div>
            <p className="text-caption text-muted">Not matched</p>
            {/* Same size as "matched". Shrinking it would be editorialising. */}
            <p className="tnum text-heading font-semibold">{roundMoney(data.unattributedRevenue)}</p>
          </div>
        </div>

        <p className="mt-4 text-label leading-relaxed text-muted">{data.statements.coverage}</p>

        {data.unattributedReasons.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {data.unattributedReasons.map((r) => (
              <li key={r.reason} className="flex items-baseline gap-2 text-caption">
                <span className="tnum shrink-0 font-medium text-ink-secondary">{r.orders}</span>
                <span className="text-muted">{r.reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {/* ---- the method breakdown: permanent, never behind a disclosure */}

      {data.byMethod.length > 0 ? (
        <Card className="mt-4">
          <p className="text-label font-medium">How each order was matched</p>
          <p className="mt-1 text-caption text-muted">
            Shares are of matched revenue, not of all revenue.
          </p>

          <ul className="mt-4 space-y-4">
            {data.byMethod.map((m) => (
              <li key={m.method}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="flex items-center gap-2">
                    <span className="text-label font-medium">{m.label}</span>
                    {/*
                      The distinction the whole section turns on. Carried by a
                      word, not only by a colour.
                    */}
                    <Badge tone={m.confidence === 'direct' ? 'success' : 'warn'}>
                      {m.confidence === 'direct' ? 'direct' : 'inferred'}
                    </Badge>
                  </span>
                  <span className="tnum text-label">
                    {roundMoney(m.revenue)}{' '}
                    <span className="text-muted">
                      · {m.orders} {m.orders === 1 ? 'order' : 'orders'} ·{' '}
                      {pct(m.shareOfAttributedBps)}
                    </span>
                  </span>
                </div>
                <div className="mt-2">
                  <InlineBar fraction={m.shareOfAttributedBps / 10_000} />
                </div>
                <p className="mt-2 text-caption leading-relaxed text-muted">{m.explanation}</p>
              </li>
            ))}
          </ul>

          {hasInferred ? (
            <div className="mt-4">
              <Notice tone="warn" title="Some of this is inferred">
                {data.statements.method}
              </Notice>
            </div>
          ) : (
            <p className="mt-4 text-label leading-relaxed text-muted">{data.statements.method}</p>
          )}
        </Card>
      ) : null}

      {/* ---- customer mix */}

      <Card className="mt-4">
        <p className="text-label font-medium">Who bought</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Stat
            label="New customers"
            value={data.newCustomerOrders.toLocaleString()}
            size="sm"
            footnote="orders"
          />
          <Stat
            label="Returning"
            value={data.returningCustomerOrders.toLocaleString()}
            size="sm"
            footnote="orders"
          />
          {/*
            Its own bucket, never folded into "returning". An export with no
            customer-type column is an absence of evidence, not evidence.
          */}
          <Stat
            label="Not stated in the export"
            value={data.unknownCustomerTypeOrders.toLocaleString()}
            size="sm"
            footnote="orders"
          />
        </div>
      </Card>

      {/* ---- per creator */}

      {showCreators && data.byCreator.length > 0 ? (
        <Card className="mt-4 overflow-hidden !p-0">
          <div className="border-b border-line p-4">
            <p className="text-label font-medium">Revenue by creator</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-label">
              <thead>
                <tr className="border-b border-line bg-sunken">
                  <th className="px-4 py-2.5 text-left font-medium text-muted">Creator</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted">Orders</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted">Revenue</th>
                  <th className="px-4 py-2.5 text-right font-medium text-muted">Commission</th>
                  <th className="px-4 py-2.5 text-left font-medium text-muted">Matched by</th>
                </tr>
              </thead>
              <tbody>
                {data.byCreator.map((c) => (
                  <tr key={c.creatorId} className="border-b border-line last:border-0">
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{c.displayName ?? 'Creator'}</span>
                      {c.handle ? (
                        <span className="ml-1.5 text-caption text-muted">@{c.handle}</span>
                      ) : null}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right">{c.orders}</td>
                    <td className="tnum px-4 py-2.5 text-right font-medium">
                      {roundMoney(c.revenue)}
                    </td>
                    <td className="tnum px-4 py-2.5 text-right text-muted">
                      {roundMoney(c.commission)}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="flex flex-wrap gap-1">
                        {c.methods.map((m) => (
                          <Badge
                            key={m}
                            tone={m === 'link_last_touch' ? 'warn' : 'neutral'}
                          >
                            {m === 'code_redemption'
                              ? 'code'
                              : m === 'link_last_touch'
                                ? 'link'
                                : 'by hand'}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {/*
        Said inside the section, not left to the methodology footer. The limit
        of attribution is part of reading the number, not an appendix to it.
      */}
      <div className="mt-4">
        <Notice tone="info" title="What attribution does and does not say">
          {data.statements.causation}
        </Notice>
      </div>

      {data.refundedOrders > 0 ? (
        <p className="mt-3 text-label leading-relaxed text-muted">{data.statements.refunds}</p>
      ) : null}
    </section>
  );
}
