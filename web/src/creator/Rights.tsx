import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Badge, Button, Card, Field, Notice, Spinner, inputClass } from '../ui/primitives.jsx';

/**
 * What the brand is asking to do with the creator's work, and their answer.
 *
 * The design problem here is the opposite of a normal consent screen. The easy
 * thing is a checkbox and an "I agree"; the honest thing is a page where the
 * creator has actually read what they are handing over, because "perpetual,
 * worldwide, paid amplification, with editing" is a serious grant and most
 * people have no idea that is what they clicked.
 *
 * So: every term is a separate line in plain words, the consequential ones are
 * called out rather than listed, and the wording comes from the server so it
 * cannot drift from the record being written.
 */

interface Licence {
  id: string;
  campaignId: string;
  campaignName: string;
  brandName: string | null;
  state: 'none' | 'awaiting_creator' | 'active' | 'not_yet_started' | 'expired' | 'revoked';
  summary: string;
  needsYourDecision: boolean;
  headline: string;
  points: string[];
  isPerpetual: boolean;
  licenseFeeMinor: number | null;
  currency: string | null;
  grantedAt: string | null;
  revokedAt: string | null;
  startsAt: string;
  endsAt: string | null;
  termsSha256: string | null;
}

interface AdPost {
  postId: string;
  campaignId: string;
  platform: string;
  format: string;
  postedAt: string;
  adPlatformLabel: string | null;
  providedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  live: boolean;
}

const STATE_TONE: Record<Licence['state'], 'neutral' | 'accent' | 'warn' | 'danger' | 'success'> = {
  none: 'neutral',
  awaiting_creator: 'warn',
  active: 'success',
  not_yet_started: 'accent',
  expired: 'neutral',
  revoked: 'danger',
};

const STATE_LABEL: Record<Licence['state'], string> = {
  none: 'Nothing asked',
  awaiting_creator: 'Waiting on you',
  active: 'You agreed',
  not_yet_started: 'Starts later',
  expired: 'Ended',
  revoked: 'Withdrawn',
};

export function Rights(): ReactNode {
  const [licences, setLicences] = useState<Licence[] | null>(null);
  const [adPosts, setAdPosts] = useState<AdPost[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, a] = await Promise.all([
        api.get<{ licences: Licence[] }>('/api/creator/licences'),
        api.get<{ posts: AdPost[] }>('/api/creator/ad-authorisations'),
      ]);
      setLicences(l.licences);
      setAdPosts(a.posts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <Notice tone="danger" title="Could not load">
        {error}
      </Notice>
    );
  }
  if (!licences) return <Spinner label="Loading…" />;

  async function act(id: string, path: string, body: unknown): Promise<void> {
    setBusy(id);
    try {
      await api.post(path, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  }

  const pending = licences.filter((l) => l.needsYourDecision);
  const settled = licences.filter((l) => !l.needsYourDecision);

  return (
    <div className="space-y-5">
      {licences.length === 0 ? (
        <Card>
          <p className="font-medium">Nobody has asked to reuse your posts.</p>
          <p className="mt-1 text-label text-muted">
            If a brand wants to reshare, boost, or advertise with something you made, the request
            turns up here first. Nothing happens until you say yes.
          </p>
        </Card>
      ) : null}

      {pending.length > 0 ? (
        <Notice tone="warn" title={pending.length === 1 ? 'One request needs you' : `${pending.length} requests need you`}>
          Read these before agreeing. Some of them last forever.
        </Notice>
      ) : null}

      {[...pending, ...settled].map((licence) => (
        <Card key={licence.id} className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-label text-muted">{licence.brandName ?? 'Brand'}</p>
              <h2 className="text-heading font-semibold tracking-tight">{licence.campaignName}</h2>
            </div>
            <Badge tone={STATE_TONE[licence.state]}>{STATE_LABEL[licence.state]}</Badge>
          </div>

          <p className="text-label text-muted">{licence.summary}</p>

          <div>
            <p className="text-label font-medium">They want to use: {licence.headline}</p>
            <ul className="mt-2 space-y-2">
              {licence.points.map((point, i) => (
                <li key={i} className="flex gap-2 text-label leading-relaxed">
                  <span aria-hidden="true" className="mt-1.5 size-1 shrink-0 rounded-full bg-muted" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </div>

          {/*
            Called out rather than listed. "No end date" buried in a bullet is
            how people agree to something they would have refused.
          */}
          {licence.isPerpetual && licence.needsYourDecision ? (
            <Notice tone="warn" title="This one has no end date">
              If you agree, they can keep using it indefinitely. You can still withdraw later, but
              you would have to come back here and do it.
            </Notice>
          ) : null}

          {licence.licenseFeeMinor !== null ? (
            <p className="text-label">
              <span className="text-muted">They are paying for these rights: </span>
              <span className="tnum font-medium">
                {(licence.licenseFeeMinor / 100).toFixed(2)} {licence.currency ?? ''}
              </span>
            </p>
          ) : (
            licence.needsYourDecision && (
              <p className="text-label text-muted">
                No separate fee is attached to these rights.
              </p>
            )
          )}

          {licence.needsYourDecision && licence.termsSha256 ? (
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy === licence.id}
                onClick={() =>
                  void act(licence.id, `/api/creator/licences/${licence.id}/grant`, {
                    termsSha256: licence.termsSha256,
                    agree: true,
                  })
                }
              >
                I agree to this
              </Button>
              <Button
                variant="ghost"
                loading={busy === licence.id}
                onClick={() =>
                  void act(licence.id, `/api/creator/licences/${licence.id}/withdraw`, {
                    reason: null,
                  })
                }
              >
                No thanks
              </Button>
            </div>
          ) : null}

          {licence.state === 'active' ? (
            <WithdrawBlock
              busy={busy === licence.id}
              onWithdraw={(reason) =>
                void act(licence.id, `/api/creator/licences/${licence.id}/withdraw`, { reason })
              }
            />
          ) : null}
        </Card>
      ))}

      {adPosts.length > 0 ? (
        <Card className="space-y-3">
          <h2 className="text-heading font-semibold tracking-tight">Ad codes you have given</h2>
          <p className="text-label text-muted">
            These let the brand run your post as an ad from their ads account. You generated them in
            the app; we never see how they were made and cannot make one for you.
          </p>
          <ul className="divide-y divide-line border-t border-line">
            {adPosts.map((p) => (
              <li key={p.postId} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-label font-medium">{p.adPlatformLabel ?? 'Ad code'}</p>
                  <p className="truncate text-caption text-muted">
                    {p.expiresAt
                      ? `${p.expired ? 'Expired' : 'Expires'} ${new Date(p.expiresAt).toLocaleDateString()}`
                      : 'No expiry given'}
                  </p>
                </div>
                {p.live ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === p.postId}
                    onClick={() =>
                      void act(
                        p.postId,
                        `/api/creator/posts/${p.postId}/ad-authorisation/withdraw`,
                        {},
                      )
                    }
                  >
                    Withdraw
                  </Button>
                ) : (
                  <Badge tone="neutral">withdrawn</Badge>
                )}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Withdrawal is one click away and does not demand an explanation.
 *
 * Requiring a reason to stop someone using your face would be a dark pattern.
 * The box is there for people who want to say something, and empty is fine.
 */
function WithdrawBlock({
  busy,
  onWithdraw,
}: {
  busy: boolean;
  onWithdraw: (reason: string | null) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-label text-muted underline underline-offset-2 hover:text-ink"
      >
        Withdraw this permission
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-[--radius-md] border border-line p-3">
      <p className="text-label">
        They will have to stop using your post. You do not have to give a reason.
      </p>
      <Field label="Anything you want to add (optional)">
        <input
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Optional"
        />
      </Field>
      <div className="flex gap-2">
        <Button variant="danger" loading={busy} onClick={() => onWithdraw(reason.trim() || null)}>
          Withdraw
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
