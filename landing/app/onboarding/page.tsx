import Link from 'next/link';
import { pricing, site } from '@/content/landing';
import { normaliseBrandUrl } from '@/lib/url';

/**
 * Where the hero input goes. A stub for now: it proves the hand-off works —
 * the URL, plan and interval all arrive, and an invalid URL arriving by a
 * hand-typed link is caught rather than trusted — and stops there.
 */
export const metadata = { title: `Get started — ${site.name}` };

type Search = Promise<Record<string, string | string[] | undefined>>;

export default async function Onboarding({ searchParams }: { searchParams: Search }) {
  const params = await searchParams;
  const one = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : null);

  const parsed = one('url') ? normaliseBrandUrl(one('url') ?? '') : null;
  const plan = pricing.tiers.find((t) => t.id === one('plan')) ?? null;
  const interval = one('interval') === 'annual' ? 'annual' : one('interval') === 'monthly' ? 'monthly' : null;
  const describing = one('describe') === '1';

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-20">
      <Link href="/" className="headline text-[26px]">
        {site.wordmark}
      </Link>
      <h1 className="headline mt-10 text-title">
        {describing ? 'Tell us about it.' : <>Let’s build your <em className="italic text-accent">profile.</em></>}
      </h1>

      <dl className="mt-8 divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
        <Row label="Website">
          {parsed?.ok ? parsed.value : parsed ? <span className="text-pass">Not a website we can read</span> : <span className="text-muted">None given</span>}
        </Row>
        <Row label="Plan">{plan ? plan.name : <span className="text-muted">Not chosen yet</span>}</Row>
        <Row label="Billing">{interval ?? <span className="text-muted">Not chosen yet</span>}</Row>
      </dl>

      <p className="mt-6 text-[14px] text-muted">
        Onboarding is not built yet. This page confirms what the landing page handed over.
      </p>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] gap-4 px-5 py-3.5 text-[15px]">
      <dt className="text-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
