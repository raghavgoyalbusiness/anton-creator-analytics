import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Button, Card, Notice, Spinner, inputClass } from '../ui/primitives.jsx';

interface RosterCreator {
  id: string;
  displayName: string;
  handles: { platform: string; handle: string }[];
  status: string;
  nicheTags: string[];
  country: string | null;
  city: string | null;
  followers: number | null;
  followerBand: string;
  hasConsent: boolean;
  medianEngagementRate: number | null;
  reportablePosts: number;
  campaignsJoined: number;
  campaignsCompleted: number;
  lastPostedAt: string | null;
}

interface RosterResponse {
  creators: RosterCreator[];
  bands: { key: string; label: string }[];
  niches: string[];
  total: number;
}

type Sort = 'followers' | 'engagement' | 'posts' | 'name';

export function Roster(): ReactNode {
  const [data, setData] = useState<RosterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [invites, setInvites] = useState<{ warning: string; links: { displayName: string; url: string }[] } | null>(null);

  const [niche, setNiche] = useState('');
  const [band, setBand] = useState('');
  const [platform, setPlatform] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('followers');

  const load = useCallback(async (): Promise<void> => {
    const params = new URLSearchParams({ sort, limit: '500' });
    if (niche) params.set('niche', niche);
    if (band) params.set('band', band);
    if (platform) params.set('platform', platform);
    if (search.trim()) params.set('search', search.trim());
    try {
      setData(await api.get<RosterResponse>(`/api/operator/roster?${params.toString()}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the roster.');
    }
  }, [niche, band, platform, search, sort]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const creators = data?.creators ?? [];
  const allSelected = creators.length > 0 && creators.every((c) => selected.has(c.id));

  const eligible = useMemo(
    () => creators.filter((c) => selected.has(c.id) && c.status !== 'removed'),
    [creators, selected],
  );

  async function invite(): Promise<void> {
    try {
      const res = await api.post<{ warning: string; links: { displayName: string; url: string }[] }>(
        '/api/operator/invites',
        { creatorIds: eligible.map((c) => c.id), campaignId: null },
      );
      setInvites(res);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not mint links.');
    }
  }

  if (invites) {
    const text = invites.links.map((l) => `${l.displayName}: ${l.url}`).join('\n');
    return (
      <div className="space-y-4">
        <Notice tone="warn" title="Links minted — send them now">
          {invites.warning}
        </Notice>
        <Card>
          <p className="mb-2 text-label text-muted">
            Shown once. Closing this loses them; you would have to mint again.
          </p>
          <textarea
            className={`${inputClass} font-mono text-caption`}
            rows={Math.min(16, invites.links.length + 1)}
            readOnly
            value={text}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="mt-3 flex gap-2">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(text);
              }}
            >
              Copy all
            </Button>
            <Button variant="ghost" onClick={() => setInvites(null)}>
              Done
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <input
          className={`${inputClass} max-w-48`}
          placeholder="Search name or handle"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={`${inputClass} max-w-40`} value={niche} onChange={(e) => setNiche(e.target.value)}>
          <option value="">All niches</option>
          {(data?.niches ?? []).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select className={`${inputClass} max-w-44`} value={band} onChange={(e) => setBand(e.target.value)}>
          <option value="">All sizes</option>
          {(data?.bands ?? []).map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
        <select className={`${inputClass} max-w-36`} value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="">Both platforms</option>
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
        </select>
        <select className={`${inputClass} max-w-44`} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="followers">Most followers</option>
          <option value="engagement">Best engagement</option>
          <option value="posts">Most posts</option>
          <option value="name">Name</option>
        </select>
      </div>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-[--radius-lg] border border-accent/40 bg-accent-soft px-4 py-3">
          <span className="text-label font-medium text-accent">{selected.size} selected</span>
          <Button onClick={() => void invite()}>Mint invite links</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      {!data ? (
        <Spinner label="Loading the roster…" />
      ) : (
        <div className="overflow-x-auto rounded-[--radius-lg] border border-line">
          <table className="w-full min-w-[56rem] text-label">
            <thead>
              <tr className="border-b border-line text-left text-caption uppercase tracking-wide text-muted">
                <th className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(creators.map((c) => c.id)) : new Set())
                    }
                  />
                </th>
                <th className="px-3 py-2 font-medium">Creator</th>
                <th className="px-3 py-2 font-medium">Niche</th>
                <th className="px-3 py-2 text-right font-medium">Followers</th>
                <th className="px-3 py-2 text-right font-medium">Median ER</th>
                <th className="px-3 py-2 text-right font-medium">Posts</th>
                <th className="px-3 py-2 text-right font-medium">Campaigns</th>
                <th className="px-3 py-2 font-medium">Consent</th>
              </tr>
            </thead>
            <tbody>
              {creators.map((c) => (
                <tr key={c.id} className="border-b border-line/70 last:border-0 hover:bg-sunken">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(c.id);
                          else next.delete(c.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium">{c.displayName}</div>
                    <div className="text-caption text-muted">
                      {c.handles.map((h) => `@${h.handle}`).join(', ')}
                      {c.city ? ` · ${c.city}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-caption text-muted">{c.nicheTags.join(', ') || '—'}</td>
                  <td className="px-3 py-2 text-right tnum">
                    {c.followers?.toLocaleString() ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tnum">
                    {c.medianEngagementRate === null ? (
                      <span className="text-muted" title="No signed-off posts yet — not the same as zero">
                        not measured
                      </span>
                    ) : (
                      `${(c.medianEngagementRate * 100).toFixed(1)}%`
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tnum">{c.reportablePosts}</td>
                  <td className="px-3 py-2 text-right tnum">
                    {c.campaignsCompleted}/{c.campaignsJoined}
                  </td>
                  <td className="px-3 py-2">
                    {c.hasConsent ? (
                      <span className="text-caption text-accent">on record</span>
                    ) : (
                      <span className="text-caption text-warn">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-caption text-muted">
        Median, not mean: one viral post should not decide who gets the next campaign.
        Only posts you have signed off count towards it.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- nudge list */

interface Nudge {
  creatorId: string;
  displayName: string;
  handle: string | null;
  campaignName: string;
  reason: string;
  daysWaiting: number | null;
}

interface NudgeResponse {
  thresholdHours: number;
  acceptedNotPosted: Nudge[];
  postedNotSubmitted: Nudge[];
  invitedNoReply: Nudge[];
  total: number;
}

export function Nudges(): ReactNode {
  const [data, setData] = useState<NudgeResponse | null>(null);
  const [days, setDays] = useState(5);

  useEffect(() => {
    void api
      .get<NudgeResponse>(`/api/operator/nudges?thresholdHours=${days * 24}`)
      .then(setData)
      .catch(() => setData(null));
  }, [days]);

  if (!data) return <Spinner label="Working out who is stuck…" />;

  const groups: [string, string, Nudge[]][] = [
    [
      'Posted, no screenshot yet',
      'They have done the work. This is a one-line reminder, not a chase.',
      data.postedNotSubmitted,
    ],
    [
      'Accepted, nothing posted',
      'Check the product arrived before assuming they have forgotten.',
      data.acceptedNotPosted,
    ],
    ['Invited, no reply', 'May never have seen the message.', data.invitedNoReply],
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <label className="text-label text-muted">Stuck for more than</label>
        <select
          className={`${inputClass} max-w-28`}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {[1, 3, 5, 7, 14].map((d) => (
            <option key={d} value={d}>
              {d} day{d === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        <span className="text-label text-muted">{data.total} in total</span>
      </div>

      {groups.map(([title, note, rows]) => (
        <section key={title}>
          <h3 className="font-semibold">
            {title} <span className="font-normal text-muted">({rows.length})</span>
          </h3>
          <p className="mb-2 text-label text-muted">{note}</p>
          {rows.length === 0 ? (
            <p className="text-label text-muted">Nobody.</p>
          ) : (
            <div className="overflow-hidden rounded-[--radius-lg] border border-line">
              {rows.map((n, i) => (
                <div
                  key={`${n.creatorId}-${i}`}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 px-4 py-2.5 last:border-0"
                >
                  <div>
                    <span className="font-medium">{n.displayName}</span>
                    {n.handle ? <span className="text-muted"> @{n.handle}</span> : null}
                    <span className="text-label text-muted"> · {n.campaignName}</span>
                  </div>
                  <span className="text-label text-muted">
                    {n.daysWaiting !== null ? `${n.daysWaiting} days` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
