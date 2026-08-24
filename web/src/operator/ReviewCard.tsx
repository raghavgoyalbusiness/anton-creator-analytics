import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { METRIC_KEYS, type MetricKey, type PostMetrics } from '@anton/shared';
import { api } from '../lib/api.js';
import { Button, Notice, inputClass } from '../ui/primitives.jsx';
import { METRIC_LABELS, type QueueItem } from './types.js';

const MIN_CONFIDENCE = 0.85;

/**
 * One post under review: screenshot left, editable fields right.
 *
 * Fields are ordered by how much they need attention — low-confidence and
 * plausibility-implicated metrics first — so the operator's eye lands on the
 * suspect number rather than scanning eleven rows for it.
 */
export function ReviewCard({
  item,
  onDecided,
  onSkip,
  busy,
}: {
  item: QueueItem;
  onDecided: (decision: {
    decision: 'verify' | 'reject';
    metrics: PostMetrics;
    rejectedReason: string | null;
    overrideReasons: Partial<Record<MetricKey, string>>;
  }) => void;
  onSkip: () => void;
  busy: boolean;
}): ReactNode {
  const [draft, setDraft] = useState<PostMetrics>(item.metrics);
  const [reasons, setReasons] = useState<Partial<Record<MetricKey, string>>>({});
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const rejectRef = useRef<HTMLTextAreaElement>(null);

  // A new post replaces the draft entirely; carrying edits across would apply
  // one creator's correction to another's numbers.
  useEffect(() => {
    setDraft(item.metrics);
    setReasons({});
    setRejecting(false);
    setRejectReason('');
    setShowRaw(false);
    setRawText(null);
  }, [item.id, item.metrics]);

  useEffect(() => {
    if (rejecting) rejectRef.current?.focus();
  }, [rejecting]);

  const flaggedFields = useMemo(() => {
    const set = new Set<MetricKey>();
    for (const violation of item.extraction?.plausibility.violations ?? []) {
      for (const field of violation.fields) set.add(field);
    }
    return set;
  }, [item]);

  const orderedKeys = useMemo(() => {
    const score = (key: MetricKey): number => {
      const confidence = item.extraction?.fieldConfidence[key];
      const low = confidence != null && confidence < MIN_CONFIDENCE;
      if (flaggedFields.has(key)) return 0;
      if (low) return 1;
      if (item.metrics[key] !== null) return 2;
      return 3;
    };
    return [...METRIC_KEYS].sort((a, b) => score(a) - score(b));
  }, [item, flaggedFields]);

  const changed = METRIC_KEYS.filter((k) => draft[k] !== item.metrics[k]);

  function setMetric(key: MetricKey, raw: string): void {
    const trimmed = raw.trim();
    if (trimmed === '') {
      setDraft((d) => ({ ...d, [key]: null }));
      return;
    }
    const value = Number(trimmed.replace(/,/g, ''));
    if (!Number.isFinite(value)) return;
    setDraft((d) => ({ ...d, [key]: Math.trunc(value) }));
  }

  async function loadRaw(): Promise<void> {
    setShowRaw(true);
    if (rawText !== null) return;
    try {
      const res = await api.get<{ rawResponse: string | null }>(
        `/api/operator/posts/${item.id}/raw`,
      );
      setRawText(res.rawResponse ?? '(nothing stored)');
    } catch {
      setRawText('(could not load)');
    }
  }

  function verify(): void {
    onDecided({ decision: 'verify', metrics: draft, rejectedReason: null, overrideReasons: reasons });
  }

  function reject(): void {
    if (rejectReason.trim().length === 0) return;
    onDecided({
      decision: 'reject',
      metrics: draft,
      rejectedReason: rejectReason.trim(),
      overrideReasons: reasons,
    });
  }

  const extraction = item.extraction;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      {/* ------------------------------------------------------ screenshot */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        {item.screenshotUrl ? (
          <a href={item.screenshotUrl} target="_blank" rel="noreferrer noopener">
            <img
              src={item.screenshotUrl}
              alt={`Insights screenshot submitted by ${item.creator.displayName}`}
              className="max-h-[75vh] w-full rounded-xl border border-line object-contain"
            />
          </a>
        ) : (
          <Notice tone="warn">No screenshot is stored for this post.</Notice>
        )}
        <p className="mt-2 text-xs text-muted">
          Link expires in 60 seconds. Refresh the queue for a new one.
        </p>
      </div>

      {/* ---------------------------------------------------------- fields */}
      <div className="space-y-4">
        <header>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold">{item.creator.displayName}</h2>
            <span className="text-sm text-muted">
              {item.creator.handle ? `@${item.creator.handle} · ` : ''}
              {item.platform} {item.format}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {item.campaign.name} · posted{' '}
            {new Date(item.postedAt).toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            })}
            {item.creator.followersAtPost !== null
              ? ` · ${item.creator.followersAtPost.toLocaleString()} followers then`
              : ' · follower count unknown'}
          </p>
        </header>

        {extraction?.instructionTextDetected ? (
          <Notice tone="danger" title="Instruction text detected in this image">
            The model reported text inside this screenshot that looked like an instruction.
            It was told to ignore it. Look at the image yourself and review this creator's
            other submissions before accepting anything here.
          </Notice>
        ) : null}

        {extraction && !extraction.parseOk ? (
          <Notice tone="warn" title="The model did not return usable data">
            {extraction.parseError ?? 'Unknown parse failure.'} Read the numbers off the
            screenshot yourself, or reject and ask for a clearer one.
          </Notice>
        ) : null}

        {extraction && extraction.routingReasons.length > 0 ? (
          <Notice tone="warn" title={`Held back for ${extraction.routingReasons.length} reason${extraction.routingReasons.length === 1 ? '' : 's'}`}>
            <ul className="list-disc space-y-1 pl-4">
              {extraction.routingReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <div className="rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Metric</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Confidence</th>
              </tr>
            </thead>
            <tbody>
              {orderedKeys.map((key) => {
                const confidence = extraction?.fieldConfidence[key] ?? null;
                const low = confidence != null && confidence < MIN_CONFIDENCE;
                const flagged = flaggedFields.has(key);
                const edited = draft[key] !== item.metrics[key];
                return (
                  <tr key={key} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2">
                      <span className={flagged ? 'font-medium text-danger' : ''}>
                        {METRIC_LABELS[key]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className={`w-32 rounded-lg border px-2 py-1 tabular-nums ${
                          edited
                            ? 'border-accent bg-accent-soft'
                            : flagged
                              ? 'border-danger/50'
                              : low
                                ? 'border-warn/50'
                                : 'border-line'
                        } bg-transparent`}
                        inputMode="numeric"
                        value={draft[key] === null ? '' : String(draft[key])}
                        placeholder="not captured"
                        onChange={(e) => setMetric(key, e.target.value)}
                        disabled={busy}
                      />
                      {edited ? (
                        <input
                          className="mt-1 w-full rounded-lg border border-line bg-transparent px-2 py-1 text-xs"
                          placeholder="Why? (optional but kept forever)"
                          value={reasons[key] ?? ''}
                          onChange={(e) => setReasons((r) => ({ ...r, [key]: e.target.value }))}
                        />
                      ) : null}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {confidence === null ? (
                        <span className="text-muted">—</span>
                      ) : (
                        <span className={low ? 'text-warn' : 'text-muted'}>
                          {(confidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {changed.length > 0 ? (
          <Notice tone="info">
            {changed.length} {changed.length === 1 ? 'value' : 'values'} changed. Each will be
            recorded with the original, your name and the time — permanently.
          </Notice>
        ) : null}

        {item.manualOverrides.length > 0 ? (
          <details className="rounded-xl border border-line px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium">
              {item.manualOverrides.length} earlier correction
              {item.manualOverrides.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 space-y-1 text-muted">
              {item.manualOverrides.map((o, i) => (
                <li key={i}>
                  <span className="font-medium text-ink">{METRIC_LABELS[o.field]}</span>{' '}
                  {o.from ?? 'null'} → {o.to ?? 'null'}
                  {o.reason ? ` · ${o.reason}` : ''} ·{' '}
                  {new Date(o.at).toLocaleDateString()}
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        <TrustPanel item={item} />

        <details
          className="rounded-xl border border-line px-4 py-3 text-sm"
          open={showRaw}
          onToggle={(e) => {
            if ((e.target as HTMLDetailsElement).open) void loadRaw();
          }}
        >
          <summary className="cursor-pointer font-medium">Raw model output</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-line/30 p-3 text-xs">
            {rawText ?? 'Loading…'}
          </pre>
        </details>

        {rejecting ? (
          <div className="space-y-2">
            <textarea
              ref={rejectRef}
              className={inputClass}
              rows={2}
              placeholder="Why is this being rejected? The creator sees a prompt to resubmit."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="danger" onClick={reject} disabled={busy || rejectReason.trim() === ''}>
                Confirm rejection
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={verify} disabled={busy}>
              Approve <kbd className="ml-1 text-xs opacity-70">A</kbd>
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(true)} disabled={busy}>
              Reject <kbd className="ml-1 text-xs opacity-70">R</kbd>
            </Button>
            <Button variant="ghost" onClick={onSkip} disabled={busy}>
              Skip <kbd className="ml-1 text-xs opacity-70">J</kbd>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TrustPanel({ item }: { item: QueueItem }): ReactNode {
  const trust = item.trust;
  if (!trust) return null;

  const rows: [string, string][] = [];
  if (trust.submissionLagHours !== null) {
    rows.push([
      'Submitted',
      `${Math.round(trust.submissionLagHours)}h after posting${trust.withinSubmissionWindow === false ? ' — outside the window' : ''}`,
    ]);
  }
  rows.push([
    'EXIF',
    trust.exifPresent
      ? 'Present before stripping — worth a look, a screenshot usually has none'
      : 'None, which is normal for a screenshot and not a red flag',
  ]);
  if (trust.historicalDeviation?.deviationMultiple != null) {
    rows.push([
      'Vs own median',
      `${trust.historicalDeviation.deviationMultiple.toFixed(1)}x across ${trust.historicalDeviation.sampleSize} prior posts`,
    ]);
  }
  if (trust.publicCrossCheck) {
    rows.push([
      'Public page',
      trust.publicCrossCheck.note ?? trust.publicCrossCheck.status.replace(/_/g, ' '),
    ]);
  }
  if (trust.flaggedForSpotAudit) {
    rows.push([
      'Spot audit',
      trust.spotAuditOutcome ?? 'Selected — arrange a live screen share before reporting',
    ]);
  }

  return (
    <details className="rounded-xl border border-line px-4 py-3 text-sm">
      <summary className="cursor-pointer font-medium">Trust signals</summary>
      <dl className="mt-2 space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex gap-3">
            <dt className="w-32 shrink-0 text-muted">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">
        These are evidence, not verdicts. A screenshot is creator-reported and forgeable;
        none of this makes a number platform-verified.
      </p>
    </details>
  );
}
