import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError, exchangeToken } from '../lib/api.js';
import { Card, Notice, Spinner } from '../ui/primitives.jsx';
import { ConsentGate } from './ConsentGate.jsx';
import { SubmitFlow } from './SubmitFlow.jsx';
import { MyData } from './MyData.jsx';
import { FORMAT_LABELS, type CreatorSessionResponse } from './types.js';

type Tab = 'submit' | 'history' | 'data';

/**
 * The creator surface root.
 *
 * The token comes from the URL path once, is handed to the API client, and is
 * then stripped from the address bar via replaceState so it does not sit in
 * browser history or get shoulder-surfed. It is never written to storage.
 */
export function CreatorApp(): ReactNode {
  const { token } = useParams<{ token: string }>();
  const [session, setSession] = useState<CreatorSessionResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tab, setTab] = useState<Tab>('submit');

  const load = useCallback(async () => {
    try {
      const data = await api.get<CreatorSessionResponse>('/api/creator/session');
      setSession(data);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? { code: err.code, message: err.message }
          : { code: 'unknown', message: 'Something went wrong.' },
      );
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function boot(): Promise<void> {
      // With a token in the path, swap it for a session cookie, then strip it
      // from the address bar so it is not in history or over someone's
      // shoulder. Without one, an existing cookie may already be valid.
      if (token) {
        try {
          await exchangeToken(token);
        } catch (err) {
          if (cancelled) return;
          setError(
            err instanceof ApiError
              ? { code: err.code, message: err.message }
              : { code: 'unknown', message: 'This link could not be opened.' },
          );
          return;
        } finally {
          window.history.replaceState(null, '', '/c');
        }
      }
      if (!cancelled) await load();
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [token, load]);

  if (error) {
    const recoverable =
      error.code === 'link_expired' || error.code === 'link_already_used' || error.code === 'link_revoked';
    return (
      <main className="mx-auto w-full max-w-md px-5 py-16">
        <Notice tone={recoverable ? 'warn' : 'danger'} title="Cannot open this link">
          {error.message}
        </Notice>
        {recoverable ? (
          <p className="mt-4 text-sm text-muted">
            Links last 15 minutes and work once, so they are useless to anyone who finds
            one later. Message the community and we will send you a fresh one.
          </p>
        ) : null}
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-md items-center px-5 py-16">
        <Spinner label="Opening your link…" />
      </main>
    );
  }

  if (session.consent.required) {
    return (
      <ConsentGate
        version={session.consent.version}
        text={session.consent.text}
        reason={session.consent.reason}
        onGranted={() => void load()}
      />
    );
  }

  const firstName = session.creator.displayName.split(' ')[0] ?? 'there';

  return (
    <main className="mx-auto w-full max-w-md px-5 pb-10 pt-8">
      <header className="mb-6">
        <p className="text-sm text-muted">Anton</p>
        <h1 className="text-2xl font-semibold tracking-tight">Hi {firstName}</h1>
      </header>

      <nav className="mb-6 grid grid-cols-3 gap-1 rounded-xl border border-line p-1" role="tablist">
        {(
          [
            ['submit', 'Submit'],
            ['history', 'Sent'],
            ['data', 'My data'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`min-h-10 rounded-lg text-sm font-medium transition-colors ${
              tab === key ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'submit' ? (
        <SubmitFlow campaigns={session.campaigns} onSubmitted={() => void load()} />
      ) : null}

      {tab === 'history' ? (
        <div className="space-y-3">
          {session.submissions.length === 0 ? (
            <Notice tone="info">Nothing sent yet.</Notice>
          ) : (
            session.submissions.map((s) => {
              const campaign = session.campaigns.find((c) => c.id === s.campaignId);
              return (
                <Card key={s.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{campaign?.name ?? 'Campaign'}</p>
                    <p className="text-sm text-muted">
                      {FORMAT_LABELS[s.format]} ·{' '}
                      {new Date(s.postedAt).toLocaleDateString(undefined, {
                        day: 'numeric',
                        month: 'short',
                      })}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium ${
                      s.state === 'rejected'
                        ? 'bg-danger-soft text-danger'
                        : s.state === 'processing'
                          ? 'bg-warn-soft text-warn'
                          : 'bg-accent-soft text-accent'
                    }`}
                  >
                    {s.state === 'rejected'
                      ? 'Needs another'
                      : s.state === 'processing'
                        ? 'Checking'
                        : 'Received'}
                  </span>
                </Card>
              );
            })
          )}
        </div>
      ) : null}

      {tab === 'data' ? <MyData displayName={firstName} /> : null}

      <p className="mt-8 border-t border-line pt-4 text-center text-xs text-muted">
        This page is personal to you. Do not forward your link — anyone who opens it can
        see your analytics. Use <span className="font-medium">My data</span> to sign out
        everywhere if you think it has been shared.
      </p>
    </main>
  );
}
