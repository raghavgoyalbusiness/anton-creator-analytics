import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Button, Notice } from '../ui/primitives.jsx';
import { Markdown } from '../ui/Markdown.jsx';

/**
 * The consent gate.
 *
 * Two deliberate choices. The full text is shown inline rather than behind a
 * link, because a creator on a phone will not open a second page to read it and
 * a consent nobody read is not consent. And the button stays disabled until the
 * checkbox is ticked: no pre-ticked boxes, no implied agreement from continuing.
 */
export function ConsentGate({
  version,
  text,
  reason,
  onGranted,
}: {
  version: string;
  text: string;
  reason: 'not_given' | 'document_changed' | null;
  onGranted: () => void;
}): ReactNode {
  const [ticked, setTicked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/creator/consent', {
        agreed: true,
        scopeVersion: version,
        method: 'web_form',
      });
      onGranted();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Something went wrong. Try again.',
      );
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-8">
      <h1 className="text-title font-semibold tracking-tight">Before we store anything</h1>
      <p className="mt-2 text-muted">
        {reason === 'document_changed'
          ? 'We have updated this agreement since you last read it, so we need to ask again.'
          : 'Read this, then tell us if you are happy to go ahead.'}
      </p>

      <div className="mt-6 max-h-[55vh] overflow-y-auto rounded-[--radius-xl] border border-line bg-sunken p-5">
        <Markdown source={text} />
      </div>

      <p className="mt-3 text-caption text-muted">Version {version}</p>

      {error ? (
        <div className="mt-4">
          <Notice tone="danger">{error}</Notice>
        </div>
      ) : null}

      <label className="mt-6 flex cursor-pointer items-start gap-3 rounded-[--radius-lg] border border-line p-4">
        <input
          type="checkbox"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
          className="mt-0.5 size-5 accent-[var(--color-accent)]"
        />
        <span className="text-label leading-relaxed">
          I have read this and I agree. I understand I can download or delete everything
          at any time from this link.
        </span>
      </label>

      <div className="mt-5 flex flex-col gap-3">
        <Button onClick={() => void submit()} disabled={!ticked || submitting}>
          {submitting ? 'Saving…' : 'I agree, continue'}
        </Button>
        <p className="text-center text-caption text-muted">
          Not sure? Close this page. Nothing is stored until you agree, and nothing
          bad happens if you decide not to.
        </p>
      </div>
    </div>
  );
}
