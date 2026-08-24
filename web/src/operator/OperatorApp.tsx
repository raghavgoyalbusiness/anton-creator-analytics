import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MetricKey, PostMetrics } from '@anton/shared';
import { api, ApiError } from '../lib/api.js';
import { Button, EmptyState, Notice, Spinner, inputClass } from '../ui/primitives.jsx';
import { ReviewCard } from './ReviewCard.jsx';
import { Nudges, Roster } from './Roster.jsx';
import { Campaigns } from './Campaigns.jsx';
import { DataTools } from './DataTools.jsx';
import type { DashboardResponse, QueueItem, QueueResponse } from './types.js';

type Status = 'needs_review' | 'pending' | 'auto_accepted' | 'verified' | 'rejected' | 'all';

export function OperatorApp(): ReactNode {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    api
      .get('/api/operator/auth/me')
      .then(() => setSignedIn(true))
      .catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) {
    return (
      <main className="mx-auto flex max-w-md px-6 py-20">
        <Spinner label="Checking your session…" />
      </main>
    );
  }
  if (!signedIn) return <Login onSignedIn={() => setSignedIn(true)} />;
  return <Shell onSignedOut={() => setSignedIn(false)} />;
}

type Tab = 'queue' | 'roster' | 'nudges' | 'campaigns' | 'data';

/** The operator shell. Queue first, because that is the daily job. */
function Shell({ onSignedOut }: { onSignedOut: () => void }): ReactNode {
  const [tab, setTab] = useState<Tab>('queue');

  async function signOut(): Promise<void> {
    await api.post('/api/operator/auth/logout', {}).catch(() => undefined);
    onSignedOut();
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-6 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <nav className="flex gap-1 rounded-[--radius-lg] border border-line p-1" role="tablist">
          {(
            [
              ['queue', 'Queue'],
              ['roster', 'Roster'],
              ['nudges', 'Nudges'],
              ['campaigns', 'Campaigns'],
              ['data', 'Data'],
            ] as [Tab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`min-h-9 rounded-[--radius-md] px-4 text-label font-medium transition-colors ${
                tab === key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <Button variant="ghost" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>

      {tab === 'queue' ? <Queue onSignedOut={onSignedOut} /> : null}
      {tab === 'roster' ? <Roster /> : null}
      {tab === 'nudges' ? <Nudges /> : null}
      {tab === 'campaigns' ? <Campaigns /> : null}
      {tab === 'data' ? <DataTools /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ login */

function Login({ onSignedIn }: { onSignedIn: () => void }): ReactNode {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/operator/auth/login', { email, password, totpCode });
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-sm px-6 py-20">
      <h1 className="text-title font-semibold tracking-tight">Anton</h1>
      <p className="mt-1 text-label text-muted">Operator sign-in</p>

      <form className="mt-8 space-y-4" onSubmit={(e) => void submit(e)}>
        <label className="block">
          <span className="mb-1.5 block text-label font-medium">Email</span>
          <input
            className={inputClass}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-label font-medium">Password</span>
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-label font-medium">Authenticator code</span>
          <input
            className={`${inputClass} tnum tracking-widest`}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="000000"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
            required
          />
        </label>

        {error ? <Notice tone="danger">{error}</Notice> : null}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-6 text-caption text-muted">
        Two-factor is required on this account. It can read every creator's private
        analytics.
      </p>
    </main>
  );
}

/* ------------------------------------------------------------------ queue */

function Queue({ onSignedOut }: { onSignedOut: () => void }): ReactNode {
  const [status, setStatus] = useState<Status>('needs_review');
  const [data, setData] = useState<QueueResponse | null>(null);
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [queue, dash] = await Promise.all([
        api.get<QueueResponse>(`/api/operator/queue?status=${status}&limit=100`),
        api.get<DashboardResponse>('/api/operator/dashboard'),
      ]);
      setData(queue);
      setDashboard(dash);
      setIndex((i) => Math.min(i, Math.max(0, queue.items.length - 1)));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSignedOut();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load the queue.');
    }
  }, [status, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];
  const current: QueueItem | undefined = items[index];

  const decide = useCallback(
    async (decision: {
      decision: 'verify' | 'reject';
      metrics: PostMetrics;
      rejectedReason: string | null;
      overrideReasons: Partial<Record<MetricKey, string>>;
    }): Promise<void> => {
      if (!current) return;
      setBusy(true);
      try {
        const result = await api.post<{ overridesRecorded: number }>(
          `/api/operator/posts/${current.id}/decide`,
          decision,
        );
        setFlash(
          decision.decision === 'verify'
            ? `Approved${result.overridesRecorded > 0 ? ` with ${result.overridesRecorded} correction${result.overridesRecorded === 1 ? '' : 's'} recorded` : ''}.`
            : 'Rejected.',
        );
        // Drop it from the list in place and keep the index, so the next post
        // slides under the cursor without a reload or a scroll jump.
        setData((d) =>
          d ? { ...d, items: d.items.filter((i) => i.id !== current.id) } : d,
        );
        setIndex((i) => Math.min(i, Math.max(0, items.length - 2)));
        void load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not save that decision.');
      } finally {
        setBusy(false);
      }
    },
    [current, items.length, load],
  );

  /**
   * Keyboard driving. Ignored while focus is in a text field, so typing a
   * correction never approves a post by accident.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      const typing =
        target != null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing || busy) return;

      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'a' && current) {
        e.preventDefault();
        void decide({
          decision: 'verify',
          metrics: current.metrics,
          rejectedReason: null,
          overrideReasons: {},
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length, current, busy, decide]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2500);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <section>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-title font-semibold tracking-tight">Verification queue</h1>
          <p className="text-label text-muted">
            {items.length} in view
            {dashboard ? ` · ${dashboard.posts.needs_review ?? 0} awaiting review overall` : ''}
            {dashboard ? ` · £${(dashboard.spend.todayMinor / 100).toFixed(2)} extraction spend today` : ''}
          </p>
        </div>
        <select
          className="rounded-[--radius-md] border border-line bg-transparent px-3 py-2 text-label"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as Status);
            setIndex(0);
          }}
        >
          <option value="needs_review">Needs review</option>
          <option value="pending">Pending extraction</option>
          <option value="auto_accepted">Auto-accepted</option>
          <option value="verified">Verified</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>

      {dashboard && dashboard.instructionTextDetected > 0 ? (
        <div className="mb-4">
          <Notice tone="danger" title={`${dashboard.instructionTextDetected} image${dashboard.instructionTextDetected === 1 ? '' : 's'} contained instruction-like text`}>
            Someone uploaded a screenshot with text trying to steer the extractor. Review
            those posts and the creators who sent them.
          </Notice>
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      {flash ? (
        <div className="mb-4">
          <Notice tone="success">{flash}</Notice>
        </div>
      ) : null}

      {!data ? (
        <Spinner label="Loading the queue…" />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here.">
          {status === 'needs_review'
            ? 'Every submission has been dealt with.'
            : 'No posts match this filter.'}
        </EmptyState>
      ) : current ? (
        <>
          <div className="mb-4 flex items-center gap-3 text-label text-muted">
            <span>
              {index + 1} of {items.length}
            </span>
            <span className="text-caption">
              <kbd className="rounded border border-line px-1">J</kbd>/
              <kbd className="rounded border border-line px-1">K</kbd> move ·{' '}
              <kbd className="rounded border border-line px-1">A</kbd> approve
            </span>
          </div>
          <ReviewCard
            key={current.id}
            item={current}
            busy={busy}
            onDecided={(d) => void decide(d)}
            onSkip={() => setIndex((i) => Math.min(i + 1, items.length - 1))}
          />
        </>
      ) : null}
    </section>
  );
}
