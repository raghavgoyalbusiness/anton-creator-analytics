import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Button, Card, Notice, inputClass } from '../ui/primitives.jsx';

/**
 * Data rights, reachable from the creator's own link with no email or form.
 *
 * Export builds the JSON in the browser from the API response and hands it over
 * as a download, so the file is assembled from exactly what the creator can see.
 * Deletion requires typing DELETE: a destructive, irreversible action should
 * not be one mis-tap away on a phone.
 */
export function MyData({ displayName }: { displayName: string }): ReactNode {
  const [exporting, setExporting] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ posts: number; screenshots: number } | null>(null);
  const [signedOut, setSignedOut] = useState<string | null>(null);

  async function exportData(): Promise<void> {
    setExporting(true);
    setError(null);
    try {
      const data = await api.get<unknown>('/api/creator/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `anton-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5_000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build your export.');
    } finally {
      setExporting(false);
    }
  }

  async function deleteEverything(): Promise<void> {
    setDeleting(true);
    setError(null);
    try {
      const result = await api.post<{ postsRemoved: number; screenshotsRemoved: number }>(
        '/api/creator/delete',
        { confirm: 'DELETE' },
      );
      setDeleted({ posts: result.postsRemoved, screenshots: result.screenshotsRemoved });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete the deletion.');
      setDeleting(false);
    }
  }

  async function signOutEverywhere(): Promise<void> {
    setError(null);
    try {
      const result = await api.post<{ sessionsRevoked: number; message: string }>(
        '/api/creator/sessions/revoke-all',
        {},
      );
      setSignedOut(result.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign out.');
    }
  }

  async function withdraw(): Promise<void> {
    setError(null);
    try {
      await api.post('/api/creator/consent/withdraw', {});
      window.location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not withdraw consent.');
    }
  }

  if (deleted) {
    return (
      <Notice tone="success" title="Deleted">
        We removed {deleted.posts} {deleted.posts === 1 ? 'post' : 'posts'} and{' '}
        {deleted.screenshots} {deleted.screenshots === 1 ? 'screenshot' : 'screenshots'}. This
        link no longer works. You can close this page.
      </Notice>
    );
  }

  if (signedOut) {
    return (
      <Notice tone="success" title="Signed out everywhere">
        {signedOut}
      </Notice>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="font-semibold">If you shared your link</h2>
        <p className="mt-1 text-label text-muted">
          Signs you out on every device and cancels any unused links you have. Use this
          the moment you think someone else can open your page.
        </p>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => void signOutEverywhere()}>
          Sign out everywhere
        </Button>
      </Card>

      <Card>
        <h2 className="font-semibold">Download everything</h2>
        <p className="mt-1 text-label text-muted">
          A file with every record we hold about you, {displayName}, including links to your
          screenshots. Those links work for a few minutes, so save the images if you want
          to keep them.
        </p>
        <Button
          variant="secondary"
          className="mt-4 w-full"
          onClick={() => void exportData()}
          disabled={exporting}
        >
          {exporting ? 'Building your file…' : 'Download my data'}
        </Button>
      </Card>

      <Card>
        <h2 className="font-semibold">Stop future use</h2>
        <p className="mt-1 text-label text-muted">
          We stop using your data for anything new, but finished campaign reports stand.
          Use this if you want out of future campaigns without erasing past work.
        </p>
        <Button variant="secondary" className="mt-4 w-full" onClick={() => void withdraw()}>
          Withdraw consent
        </Button>
      </Card>

      <Card className="border-danger/30">
        <h2 className="font-semibold text-danger">Delete everything</h2>
        <p className="mt-1 text-label text-muted">
          Removes your profile, your posts, your metrics and your screenshots. This cannot
          be undone.
        </p>
        <p className="mt-3 text-label text-muted">
          Two things stay, and we would rather say so than surprise you: reports already
          downloaded by a brand cannot be un-sent, and we keep the dated note that you
          consented and then withdrew — not your data, just the record that we were allowed
          to hold it.
        </p>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-label font-medium">
            Type DELETE to confirm
          </span>
          <input
            className={inputClass}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="DELETE"
          />
        </label>
        <Button
          variant="danger"
          className="mt-3 w-full"
          disabled={confirmText !== 'DELETE' || deleting}
          onClick={() => void deleteEverything()}
        >
          {deleting ? 'Deleting…' : 'Delete everything'}
        </Button>
      </Card>

      {error ? <Notice tone="danger">{error}</Notice> : null}
    </div>
  );
}
