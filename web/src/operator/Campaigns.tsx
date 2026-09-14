import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { RightsPanel } from './RightsPanel.jsx';
import { Button, Card, Notice, Spinner, inputClass } from '../ui/primitives.jsx';

interface Campaign {
  id: string;
  name: string;
  status: string;
  objective: string;
  platforms: string[];
  startDate: string;
  endDate: string;
  currency: string;
  budgetTotal: { amountMinor: number; currency: string };
  hasBenchmark: boolean;
  creators: number;
  posts: number;
}

interface ShareLink {
  id: string;
  label: string;
  campaignId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  showCompensation: boolean;
  showCreatorHandles: boolean;
  requireEmailGate: boolean;
  viewCount: number;
  lastViewedAt: string | null;
  recentViews: { at: string; viewerEmail: string | null; ipHash: string }[];
}

function money(m: { amountMinor: number; currency: string }): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€', INR: '₹' };
  return `${symbols[m.currency] ?? m.currency}${(m.amountMinor / 100).toLocaleString()}`;
}

export function Campaigns(): ReactNode {
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ url: string; note: string | null } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const [c, l] = await Promise.all([
        api.get<{ campaigns: Campaign[] }>('/api/operator/campaigns'),
        api.get<{ links: ShareLink[] }>('/api/operator/share-links'),
      ]);
      setCampaigns(c.campaigns);
      setLinks(l.links);
      setSelected((s) => s ?? c.campaigns[0]?.id ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load campaigns.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!campaigns) return <Spinner label="Loading campaigns…" />;

  const campaign = campaigns.find((c) => c.id === selected) ?? campaigns[0];
  const campaignLinks = links.filter((l) => l.campaignId === campaign?.id);

  return (
    <div className="space-y-6">
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="overflow-hidden rounded-[--radius-lg] border border-line">
        {campaigns.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelected(c.id)}
            className={`flex w-full flex-wrap items-center justify-between gap-3 border-b border-line/70 px-4 py-3 text-left last:border-0 ${
              c.id === campaign?.id ? 'bg-accent-soft' : 'hover:bg-sunken'
            }`}
          >
            <span>
              <span className="font-medium">{c.name}</span>
              <span className="ml-2 text-caption text-muted">
                {c.status} · {c.creators} creators · {c.posts} posts
              </span>
            </span>
            <span className="text-label text-muted">
              {money(c.budgetTotal)} budget
              {c.hasBenchmark ? '' : ' · no benchmark set'}
            </span>
          </button>
        ))}
      </div>

      {campaign ? (
        <>
          <BenchmarkEditor campaign={campaign} onSaved={() => void load()} />
          <RightsPanel campaignId={campaign.id} />
          <ShareLinks
            campaign={campaign}
            links={campaignLinks}
            onChanged={() => void load()}
            onMinted={setMinted}
          />
        </>
      ) : null}

      {minted ? (
        <Card className="border-accent/40">
          <h3 className="font-semibold">Share link created</h3>
          <p className="mt-1 text-label text-muted">
            Shown once. Closing this loses it — you would have to create another.
          </p>
          {minted.note ? (
            <div className="mt-3">
              <Notice tone="warn">{minted.note}</Notice>
            </div>
          ) : null}
          <input
            className={`${inputClass} mt-3 font-mono text-caption`}
            readOnly
            value={minted.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void navigator.clipboard.writeText(minted.url)}>Copy</Button>
            <Button variant="ghost" onClick={() => setMinted(null)}>
              Done
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------- benchmark */

function BenchmarkEditor({
  campaign,
  onSaved,
}: {
  campaign: Campaign;
  onSaved: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [fee, setFee] = useState('');
  const [reach, setReach] = useState('');
  const [sourceNote, setSourceNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/operator/campaigns/${campaign.id}/benchmark`, {
        label,
        quotedFeeMinor: Math.round(Number(fee) * 100),
        quotedReach: Number(reach),
        sourceNote,
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the benchmark.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Mega-influencer benchmark</h3>
          <p className="mt-1 text-label text-muted">
            {campaign.hasBenchmark
              ? 'Set. The comparison panel appears in the brand report.'
              : 'Not set. The brand report will omit the comparison panel entirely.'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setOpen((o) => !o)}>
          {campaign.hasBenchmark ? 'Replace' : 'Set benchmark'}
        </Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <Notice tone="warn">
            This figure appears in the brand report as the thing Anton is measured against.
            It is labelled there as supplied by you and not measured — so the source note
            matters, and it is required.
          </Notice>
          <label className="block">
            <span className="mb-1 block text-label font-medium">What is being compared</span>
            <input
              className={inputClass}
              placeholder="1.4M-follower UK beauty creator, agency quote for one reel"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-label font-medium">Quoted fee ({campaign.currency})</span>
              <input
                className={inputClass}
                inputMode="decimal"
                placeholder="18000"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-label font-medium">Quoted reach</span>
              <input
                className={inputClass}
                inputMode="numeric"
                placeholder="620000"
                value={reach}
                onChange={(e) => setReach(e.target.value)}
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-label font-medium">Where this figure came from</span>
            <input
              className={inputClass}
              placeholder="Agency quote received by email, 2026-07-14"
              value={sourceNote}
              onChange={(e) => setSourceNote(e.target.value)}
            />
          </label>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button
            onClick={() => void save()}
            disabled={busy || !label || !fee || !reach || !sourceNote.trim()}
          >
            {busy ? 'Saving…' : 'Save benchmark'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/* ----------------------------------------------------------- share links */

function ShareLinks({
  campaign,
  links,
  onChanged,
  onMinted,
}: {
  campaign: Campaign;
  links: ShareLink[];
  onChanged: () => void;
  onMinted: (v: { url: string; note: string | null }) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(30);
  const [showCompensation, setShowCompensation] = useState(false);
  const [showCreatorHandles, setShowCreatorHandles] = useState(true);
  const [requireEmailGate, setRequireEmailGate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ url: string; note: string | null }>(
        '/api/operator/share-links',
        {
          campaignId: campaign.id,
          label: label || `${campaign.name} — report`,
          expiresInDays: days,
          showCompensation,
          showCreatorHandles,
          requireEmailGate,
        },
      );
      onMinted({ url: res.url, note: res.note });
      setOpen(false);
      setLabel('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the link.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string): Promise<void> {
    try {
      await api.post(`/api/operator/share-links/${id}/revoke`, {});
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke.');
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">Brand report links</h3>
          <p className="mt-1 text-label text-muted">
            {links.filter((l) => !l.revokedAt).length} live ·{' '}
            {links.filter((l) => l.revokedAt).length} revoked
          </p>
        </div>
        <Button onClick={() => setOpen((o) => !o)}>New link</Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <label className="block">
            <span className="mb-1 block text-label font-medium">Label (for your reference)</span>
            <input
              className={inputClass}
              placeholder={`${campaign.name} — report`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-label font-medium">Expires after</span>
            <select
              className={`${inputClass} max-w-40`}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[7, 14, 30, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>

          <fieldset className="space-y-2 rounded-[--radius-md] border border-line p-3">
            <legend className="px-1 text-label font-medium">What this brand sees</legend>

            <label className="flex items-start gap-2 text-label">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={showCreatorHandles}
                onChange={(e) => setShowCreatorHandles(e.target.checked)}
              />
              <span>
                Creator names and handles
                <span className="block text-caption text-muted">
                  Off shows niche and follower band instead. Worth switching off for a brand
                  that might approach your roster directly.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-label">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={showCompensation}
                onChange={(e) => {
                  setShowCompensation(e.target.checked);
                  if (e.target.checked) setRequireEmailGate(true);
                }}
              />
              <span>
                What each creator was paid
                <span className="block text-caption text-muted">
                  A brand does not need per-creator rates to read a performance report.
                  Switching this on forces the email gate on too.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 text-label">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={requireEmailGate}
                disabled={showCompensation}
                onChange={(e) => setRequireEmailGate(e.target.checked)}
              />
              <span>
                Require an emailed code before opening
                <span className="block text-caption text-muted">
                  Records which address opened the report. Forced on when rates are shown.
                </span>
              </span>
            </label>
          </fieldset>

          {error ? <Notice tone="danger">{error}</Notice> : null}

          <Button onClick={() => void create()} disabled={busy}>
            {busy ? 'Creating…' : 'Create link'}
          </Button>
        </div>
      ) : null}

      {links.length > 0 ? (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {links.map((l) => (
            <details key={l.id} className="rounded-[--radius-md] border border-line">
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3 py-2 text-label">
                <span>
                  <span className={l.revokedAt ? 'text-muted line-through' : 'font-medium'}>
                    {l.label}
                  </span>
                  <span className="ml-2 text-caption text-muted">
                    {l.revokedAt
                      ? 'revoked'
                      : new Date(l.expiresAt) < new Date()
                        ? 'expired'
                        : `expires ${new Date(l.expiresAt).toLocaleDateString()}`}
                    {l.showCompensation ? ' · shows rates' : ''}
                    {!l.showCreatorHandles ? ' · anonymised' : ''}
                    {l.requireEmailGate ? ' · email gated' : ''}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-caption text-muted">
                  <span>
                    {l.viewCount} view{l.viewCount === 1 ? '' : 's'}
                  </span>
                  {!l.revokedAt ? (
                    <button
                      className="text-danger underline"
                      onClick={(e) => {
                        e.preventDefault();
                        void revoke(l.id);
                      }}
                    >
                      Revoke
                    </button>
                  ) : null}
                </span>
              </summary>
              <div className="border-t border-line px-3 py-2 text-caption">
                {l.recentViews.length === 0 ? (
                  <p className="text-muted">Not opened yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {l.recentViews
                      .slice()
                      .reverse()
                      .map((v, i) => (
                        <li key={i} className="flex justify-between gap-3 text-muted">
                          <span>{v.viewerEmail ?? 'not email-gated'}</span>
                          <span>{new Date(v.at).toLocaleString()}</span>
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </details>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
