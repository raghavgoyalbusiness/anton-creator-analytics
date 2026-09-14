import type { ReactNode } from 'react';
import { Badge, Card, SectionHeading } from '../ui/primitives.jsx';

/**
 * Performance by trust domain, on the brand report.
 *
 * The one section in the report most likely to be over-read. "Creators trusted
 * for ingredient science convert twice as well" is exactly the kind of line a
 * brand repeats in a planning meeting, so a domain below the minimum sample
 * shows its order count and no rate — and the reason, in words, where the rate
 * would have been. Not a greyed-out number. No number.
 */

interface Money {
  amountMinor: number;
  currency: string;
}

export interface TrustDomainData {
  minimumSample: number;
  domains: {
    domain: string;
    label: string;
    isSeed: boolean;
    creators: number;
    orders: number;
    revenue: Money;
    ordersPerThousandReach: number | null;
    revenuePerCreator: Money | null;
    rateUnavailableReason: string | null;
    sampleSufficient: boolean;
  }[];
  untaggedCreators: number;
  untaggedOrders: number;
  statement: string;
}

const SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };

function roundMoney(m: Money | null): string {
  if (!m) return '—';
  return `${SYMBOLS[m.currency] ?? `${m.currency} `}${Math.round(m.amountMinor / 100).toLocaleString()}`;
}

export function TrustDomainSection({ data }: { data: TrustDomainData }): ReactNode {
  // Nothing tagged: the section is omitted rather than rendered empty. Unlike
  // revenue, an untagged campaign is not a finding the brand needs to see.
  if (data.domains.length === 0) return null;

  return (
    <section className="mb-12">
      <SectionHeading
        title="By what audiences trust them for"
        hint="Not niche. Two skincare creators can be trusted for completely different things."
      />

      <Card className="overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-label">
            <thead>
              <tr className="border-b border-line bg-sunken text-left text-muted">
                <th className="px-4 py-2.5 font-medium">Trusted for</th>
                <th className="px-4 py-2.5 text-right font-medium">Creators</th>
                <th className="px-4 py-2.5 text-right font-medium">Orders</th>
                <th className="px-4 py-2.5 text-right font-medium">Orders per 1,000 reached</th>
                <th className="px-4 py-2.5 text-right font-medium">Revenue per creator</th>
              </tr>
            </thead>
            <tbody>
              {data.domains.map((d) => (
                <tr key={d.domain} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-3">
                    <span className="font-medium">{d.label}</span>
                    {!d.isSeed ? (
                      <span className="ml-2">
                        <Badge tone="neutral">custom</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="tnum px-4 py-3 text-right">{d.creators}</td>
                  <td className="tnum px-4 py-3 text-right">{d.orders}</td>
                  {d.sampleSufficient && d.ordersPerThousandReach !== null ? (
                    <td className="tnum px-4 py-3 text-right font-medium">
                      {d.ordersPerThousandReach.toFixed(2)}
                    </td>
                  ) : (
                    <td className="px-4 py-3 text-right text-caption text-muted">
                      {d.rateUnavailableReason}
                    </td>
                  )}
                  <td className="tnum px-4 py-3 text-right">
                    {d.revenuePerCreator ? (
                      roundMoney(d.revenuePerCreator)
                    ) : (
                      <span className="text-caption text-muted">not enough orders</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line p-4">
          <p className="text-label leading-relaxed text-muted">{data.statement}</p>
          {data.untaggedCreators > 0 ? (
            <p className="mt-1.5 text-caption text-muted">
              {data.untaggedCreators} {data.untaggedCreators === 1 ? 'creator has' : 'creators have'} not
              been tagged
              {data.untaggedOrders > 0 ? `, accounting for ${data.untaggedOrders} matched orders` : ''}.
            </p>
          ) : null}
        </div>
      </Card>
    </section>
  );
}
