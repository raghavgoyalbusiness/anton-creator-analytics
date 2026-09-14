import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api.js';
import { Badge, Button, inputClass } from '../ui/primitives.jsx';

/**
 * Tagging what a creator's audience comes to them for.
 *
 * Inline on the roster row, because the judgement is made while looking at a
 * creator's work, and a separate screen is a place nobody goes. Capped at three
 * with the reason shown when the cap is hit: seven domains on one creator is a
 * judgement nobody made.
 */

export interface DomainOption {
  key: string;
  label: string;
  isSeed: boolean;
  creators: number;
}

export function TrustDomainEditor({
  creatorId,
  current,
  options,
  max,
  onSaved,
}: {
  creatorId: string;
  current: { key: string; label: string }[];
  options: DomainOption[];
  max: number;
  onSaved: (domains: { key: string; label: string }[]) => void;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<string[]>(current.map((d) => d.key));
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <button
        onClick={() => {
          setChosen(current.map((d) => d.key));
          setEditing(true);
        }}
        className="flex flex-wrap items-center gap-1 text-left"
        aria-label="Edit trust domains"
      >
        {current.length === 0 ? (
          <span className="text-caption text-muted underline decoration-dotted underline-offset-2">
            tag
          </span>
        ) : (
          current.map((d) => (
            <Badge key={d.key} tone="accent">
              {d.label}
            </Badge>
          ))
        )}
      </button>
    );
  }

  const toggle = (key: string): void => {
    setChosen((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const atCap = chosen.length >= max;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const domains = custom.trim() ? [...chosen, custom.trim()] : chosen;
      const res = await api.put<{ domains: { key: string; label: string }[] }>(
        `/api/operator/creators/${creatorId}/trust-domains`,
        { domains },
      );
      onSaved(res.domains);
      setCustom('');
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-72 space-y-2 rounded-[--radius-md] border border-line bg-surface p-3">
      <p className="text-caption text-muted">
        What does their audience come to them for? Up to {max}.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = chosen.includes(o.key);
          return (
            <button
              key={o.key}
              onClick={() => toggle(o.key)}
              disabled={!on && atCap}
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-0.5 text-caption transition-colors disabled:opacity-40 ${
                on ? 'border-accent-line bg-accent-soft text-accent-ink' : 'border-line text-muted hover:text-ink'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <input
        className={inputClass}
        placeholder={atCap ? `Remove one to add another` : 'Or type a new one'}
        value={custom}
        disabled={atCap}
        onChange={(e) => setCustom(e.target.value)}
      />
      {error ? <p className="text-caption text-danger">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" loading={busy} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
