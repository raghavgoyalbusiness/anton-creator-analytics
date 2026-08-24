import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Button, Card, Notice, inputClass } from '../ui/primitives.jsx';

/**
 * Bulk export and retention.
 *
 * Both are guarded server-side by a fresh password check. The UI catches the
 * 403 and prompts, rather than pre-emptively asking: the operator only sees the
 * password box when the server actually wants one, so re-auth stays a
 * meaningful signal rather than a habit.
 */

interface PurgePreview {
  creatorsPurged: number;
  postsDeleted: number;
  screenshotsDeleted: number;
  consentRecordsExpired: number;
  details: { creatorId: string; displayName: string; lastCampaignEndedAt: string | null }[];
}

export function DataTools(): ReactNode {
  const [reauthFor, setReauthFor] = useState<(() => Promise<void>) | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [preview, setPreview] = useState<PurgePreview | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  /** Runs an action, and on a reauth_required response queues it behind a prompt. */
  async function guarded(action: () => Promise<void>): Promise<void> {
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reauth_required') {
        setReauthFor(() => action);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }

  async function submitReauth(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/operator/auth/reauth', { password });
      const queued = reauthFor;
      setReauthFor(null);
      setPassword('');
      if (queued) await guarded(queued);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not confirm your password.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Downloads via fetch rather than a plain link so the 403 that triggers
   * re-auth is visible to us. An <a download> would silently render the error
   * JSON into a file called anton-posts.csv.
   */
  async function download(path: string, filename: string): Promise<void> {
    const response = await fetch(path, { credentials: 'same-origin' });
    if (!response.ok) {
      let code = 'unknown';
      let message = `Export failed (${response.status}).`;
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        /* keep defaults */
      }
      throw new ApiError(response.status, code, message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    setFlash(`${filename} downloaded.`);
  }

  const stamp = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      {reauthFor ? (
        <Card className="border-warn/40">
          <h3 className="font-semibold text-warn">Confirm your password</h3>
          <p className="mt-1 text-sm text-muted">
            This action reads or deletes every creator's data at once, so a session that has
            been open a while is not enough on its own.
          </p>
          <input
            className={`${inputClass} mt-3`}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitReauth();
            }}
          />
          <div className="mt-3 flex gap-2">
            <Button onClick={() => void submitReauth()} disabled={busy || password.length === 0}>
              {busy ? 'Checking…' : 'Confirm'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setReauthFor(null);
                setPassword('');
              }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {flash ? <Notice tone="success">{flash}</Notice> : null}

      <Card>
        <h3 className="font-semibold">Export posts</h3>
        <p className="mt-1 text-sm text-muted">
          Every signed-off post with its metrics, provenance and source-image hash. A CSV
          that outlives its context still says where its numbers came from.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() =>
              void guarded(() =>
                download('/api/operator/export/posts?format=csv', `anton-posts-${stamp}.csv`),
              )
            }
          >
            Download CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void guarded(() =>
                download('/api/operator/export/posts?format=json', `anton-posts-${stamp}.json`),
              )
            }
          >
            Download JSON
          </Button>
          <Button
            variant="ghost"
            onClick={() =>
              void guarded(() =>
                download(
                  '/api/operator/export/posts?format=csv&includeUnverified=true',
                  `anton-posts-all-${stamp}.csv`,
                ),
              )
            }
          >
            Include unverified
          </Button>
        </div>
      </Card>

      <Card>
        <h3 className="font-semibold">Export the audit trail</h3>
        <p className="mt-1 text-sm text-muted">
          Append-only record of every operator read, edit, override, export and share link.
          Take this before touching anything if you are investigating an incident.
        </p>
        <Button
          variant="secondary"
          className="mt-4"
          onClick={() =>
            void guarded(() => download('/api/operator/export/audit', `anton-audit-${stamp}.json`))
          }
        >
          Download audit log
        </Button>
      </Card>

      <Card className="border-danger/30">
        <h3 className="font-semibold text-danger">Retention purge</h3>
        <p className="mt-1 text-sm text-muted">
          Permanently removes creators whose last campaign ended beyond the retention
          horizon — database rows and stored screenshots both. The dated consent record
          survives on its own longer clock.
        </p>

        <Button
          variant="secondary"
          className="mt-4"
          onClick={() =>
            void guarded(async () => {
              setPreview(await api.get<PurgePreview>('/api/operator/retention/preview'));
            })
          }
        >
          Preview what would go
        </Button>

        {preview ? (
          <div className="mt-4 space-y-3 border-t border-line pt-4">
            {preview.creatorsPurged === 0 ? (
              <Notice tone="success">
                Nothing is past its retention horizon. No action needed.
              </Notice>
            ) : (
              <>
                <Notice tone="warn" title={`${preview.creatorsPurged} creators would be purged`}>
                  {preview.postsDeleted} posts and {preview.screenshotsDeleted} screenshots
                  would be permanently deleted. This cannot be undone.
                </Notice>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-sm text-muted">
                  {preview.details.map((d) => (
                    <li key={d.creatorId} className="flex justify-between gap-3">
                      <span>{d.displayName}</span>
                      <span>
                        last campaign ended{' '}
                        {d.lastCampaignEndedAt
                          ? new Date(d.lastCampaignEndedAt).toLocaleDateString()
                          : 'unknown'}
                      </span>
                    </li>
                  ))}
                </ul>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Type PURGE to confirm</span>
                  <input
                    className={inputClass}
                    value={purgeConfirm}
                    onChange={(e) => setPurgeConfirm(e.target.value)}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <Button
                  variant="danger"
                  disabled={purgeConfirm !== 'PURGE'}
                  onClick={() =>
                    void guarded(async () => {
                      const result = await api.post<PurgePreview>(
                        '/api/operator/retention/purge',
                        { confirm: 'PURGE' },
                      );
                      setFlash(
                        `Purged ${result.creatorsPurged} creators, ${result.postsDeleted} posts and ${result.screenshotsDeleted} screenshots.`,
                      );
                      setPreview(null);
                      setPurgeConfirm('');
                    })
                  }
                >
                  Purge permanently
                </Button>
              </>
            )}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
