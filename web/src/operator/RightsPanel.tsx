import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Badge, Button, Card, Field, Notice, SectionHeading, Spinner, inputClass } from '../ui/primitives.jsx';

/**
 * Rights and ad readiness for one campaign, as an account manager sees it.
 *
 * The question this panel answers is not "what rights do we have" but "what
 * don't we have yet" — which is why every participant is listed, including
 * the ones with no licence at all, and why ad readiness names the specific
 * thing that is missing rather than showing a red dot.
 *
 * There is no "mark as granted" control anywhere on this panel, and that is
 * the point of it. An operator can ask; only the creator can agree.
 */

interface LicenceRow {
  campaignCreatorId: string;
  creatorId: string;
  creatorName: string | null;
  handle: string | null;
  licenceId: string | null;
  state: 'none' | 'awaiting_creator' | 'active' | 'not_yet_started' | 'expired' | 'revoked';
  summary: string;
  usableNow: boolean;
  daysUntilExpiry: number | null;
  isPerpetual: boolean;
  permittedUseLabels: string[];
  territory: string[];
  needsAttention: boolean;
  attentionReasons: string[];
}

interface ReadinessRow {
  postId: string;
  creatorName: string | null;
  handle: string | null;
  platform: string;
  format: string;
  postedAt: string;
  ready: boolean;
  blockers: string[];
  whatIsNeeded: string | null;
  adPlatform: string | null;
  daysUntilCodeExpiry: number | null;
  code: string | null;
}

const STATE_LABEL: Record<LicenceRow['state'], string> = {
  none: 'No licence',
  awaiting_creator: 'Asked, no answer',
  active: 'Granted',
  not_yet_started: 'Granted, starts later',
  expired: 'Expired',
  revoked: 'Withdrawn',
};

const STATE_TONE: Record<LicenceRow['state'], 'neutral' | 'accent' | 'warn' | 'danger' | 'success'> = {
  none: 'neutral',
  awaiting_creator: 'warn',
  active: 'success',
  not_yet_started: 'accent',
  expired: 'neutral',
  revoked: 'danger',
};

const USES: { key: string; label: string }[] = [
  { key: 'organic_reshare', label: 'Reshare on brand feed' },
  { key: 'paid_amplification', label: 'Run as a paid ad' },
  { key: 'website', label: 'Brand website' },
  { key: 'email_marketing', label: 'Marketing emails' },
  { key: 'print', label: 'Print' },
  { key: 'in_store_display', label: 'In-store screens' },
];

export function RightsPanel({ campaignId }: { campaignId: string }): ReactNode {
  const [licences, setLicences] = useState<LicenceRow[] | null>(null);
  const [readiness, setReadiness] = useState<{
    posts: ReadinessRow[];
    counts: { total: number; ready: number; blocked: number; expiringWithin14Days: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<LicenceRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([
        api.get<{ licences: LicenceRow[] }>(`/api/operator/campaigns/${campaignId}/licences`),
        api.get<typeof readiness & object>(`/api/operator/campaigns/${campaignId}/ad-readiness`),
      ]);
      setLicences(l.licences);
      setReadiness(r);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load rights.');
    }
  }, [campaignId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!licences || !readiness) return <Spinner label="Loading rights…" />;

  const attention = licences.filter((l) => l.needsAttention);

  return (
    <Card className="space-y-6">
      <SectionHeading
        title="Rights and ads"
        hint="Nothing is permitted until the creator agrees on their own link."
      />

      {/* ---- licences */}

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-label font-medium">Content licences</p>
          <p className="tnum text-caption text-muted">
            {licences.filter((l) => l.usableNow).length} of {licences.length} creators have granted
            rights
          </p>
        </div>

        {attention.length > 0 ? (
          <div className="mb-3">
            <Notice tone="warn" title={`${attention.length} need attention`}>
              <ul className="space-y-0.5">
                {attention.map((l) => (
                  <li key={l.campaignCreatorId}>
                    <span className="font-medium">{l.creatorName ?? 'Creator'}</span>:{' '}
                    {l.attentionReasons.join('; ')}
                  </li>
                ))}
              </ul>
            </Notice>
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-label">
            <thead>
              <tr className="border-b border-line text-left text-caption text-muted">
                <th className="py-2 pr-3 font-medium">Creator</th>
                <th className="py-2 pr-3 font-medium">State</th>
                <th className="py-2 pr-3 font-medium">Uses</th>
                <th className="py-2 pr-3 font-medium">Runs</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {licences.map((l) => (
                <tr key={l.campaignCreatorId} className="border-b border-line last:border-0">
                  <td className="py-2.5 pr-3">
                    <span className="font-medium">{l.creatorName ?? 'Creator'}</span>
                    {l.handle ? <span className="ml-1.5 text-caption text-muted">@{l.handle}</span> : null}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-caption text-muted">
                    {l.permittedUseLabels.length > 0 ? l.permittedUseLabels.join(', ') : '—'}
                  </td>
                  <td className="tnum py-2.5 pr-3 text-caption text-muted">
                    {l.state === 'none'
                      ? '—'
                      : l.isPerpetual
                        ? // Unmissable: this is the term that outlives everyone's memory of agreeing to it.
                          'no end date'
                        : l.daysUntilExpiry !== null
                          ? `${l.daysUntilExpiry}d left`
                          : '—'}
                  </td>
                  <td className="py-2.5 text-right">
                    {l.state === 'none' || l.state === 'revoked' || l.state === 'expired' ? (
                      <Button size="sm" variant="secondary" onClick={() => setRequesting(l)}>
                        Ask for rights
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {requesting ? (
        <RequestForm
          row={requesting}
          campaignId={campaignId}
          onDone={() => {
            setRequesting(null);
            void load();
          }}
          onCancel={() => setRequesting(null)}
        />
      ) : null}

      {/* ---- ad readiness */}

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-label font-medium">Can it run as an ad?</p>
          <p className="tnum text-caption text-muted">
            {readiness.counts.ready} ready · {readiness.counts.blocked} blocked
            {readiness.counts.expiringWithin14Days > 0
              ? ` · ${readiness.counts.expiringWithin14Days} code${readiness.counts.expiringWithin14Days === 1 ? '' : 's'} expiring within 14 days`
              : ''}
          </p>
        </div>

        {readiness.posts.length === 0 ? (
          <p className="text-label text-muted">No posts submitted on this campaign yet.</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {readiness.posts.map((p) => (
              <li key={p.postId} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-label font-medium">
                    {p.creatorName ?? 'Creator'}{' '}
                    <span className="font-normal text-muted">
                      · {p.platform} {p.format} · {new Date(p.postedAt).toLocaleDateString()}
                    </span>
                  </p>
                  {/* The specific missing thing, not a red dot. */}
                  {p.whatIsNeeded ? (
                    <p className="mt-0.5 text-caption text-muted">{p.whatIsNeeded}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.ready ? (
                    <>
                      {p.daysUntilCodeExpiry !== null && p.daysUntilCodeExpiry <= 14 ? (
                        <Badge tone="warn">code expires in {p.daysUntilCodeExpiry}d</Badge>
                      ) : null}
                      <Badge tone="success">ready</Badge>
                      {p.code ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void navigator.clipboard?.writeText(p.code ?? '')}
                        >
                          Copy code
                        </Button>
                      ) : null}
                    </>
                  ) : (
                    <Badge tone="neutral">blocked</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

function RequestForm({
  row,
  campaignId,
  onDone,
  onCancel,
}: {
  row: LicenceRow;
  campaignId: string;
  onDone: () => void;
  onCancel: () => void;
}): ReactNode {
  const [uses, setUses] = useState<Set<string>>(new Set(['organic_reshare']));
  const [territory, setTerritory] = useState('GB');
  const [endsAt, setEndsAt] = useState('');
  const [modification, setModification] = useState(false);
  const [whitelisting, setWhitelisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/operator/licences/request', {
        campaignCreatorId: row.campaignCreatorId,
        scope: 'all_campaign_posts',
        postIds: [],
        permittedUses: [...uses],
        territory: territory
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean),
        startsAt: new Date().toISOString(),
        endsAt: endsAt ? new Date(`${endsAt}T23:59:59Z`).toISOString() : null,
        modificationPermitted: modification,
        whitelistingPermitted: whitelisting,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-[--radius-lg] border border-accent-line p-4">
      <div>
        <p className="font-medium">Ask {row.creatorName ?? 'this creator'} for rights</p>
        <p className="mt-0.5 text-caption text-muted">
          They will see each of these in plain words on their own link and decide there. Ask for
          what the brand actually needs — every extra right is one more reason to say no.
        </p>
        <p className="mt-1 text-caption text-muted">Campaign {campaignId.slice(-6)}</p>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-label font-medium">Uses</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {USES.map((u) => (
            <label key={u.key} className="flex items-center gap-2 text-label">
              <input
                type="checkbox"
                checked={uses.has(u.key)}
                onChange={(e) => {
                  const next = new Set(uses);
                  if (e.target.checked) next.add(u.key);
                  else next.delete(u.key);
                  setUses(next);
                }}
              />
              {u.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Where (country codes, or WORLDWIDE)">
          <input className={inputClass} value={territory} onChange={(e) => setTerritory(e.target.value)} />
        </Field>
        <Field label="Ends (leave blank for no end date)">
          <input
            type="date"
            className={inputClass}
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
          />
        </Field>
      </div>

      {!endsAt ? (
        <Notice tone="warn" title="No end date">
          The creator will be told plainly that this never expires. Expect more of them to decline.
        </Notice>
      ) : null}

      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={modification} onChange={(e) => setModification(e.target.checked)} />
          The brand may edit or recut the video
        </label>
        <label className="flex items-center gap-2 text-label">
          <input type="checkbox" checked={whitelisting} onChange={(e) => setWhitelisting(e.target.checked)} />
          The brand may run ads from the creator’s own handle
        </label>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="flex gap-2">
        <Button loading={busy} disabled={uses.size === 0} onClick={() => void submit()}>
          Send request
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
