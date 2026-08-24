import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { PostFormat } from '@anton/shared';
import { api, ApiError, putToPresigned } from '../lib/api.js';
import { downscaleImage, formatBytes, type DownscaleResult } from '../lib/downscale.js';
import { Button, Field, Notice, Spinner, inputClass } from '../ui/primitives.jsx';
import { FORMAT_LABELS, type CampaignSummary, type PresignResponse } from './types.js';

type Stage = 'idle' | 'preparing' | 'uploading' | 'submitting' | 'done';

/** Local datetime string for <input type="datetime-local">, in the phone's zone. */
function toLocalInputValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

/**
 * The submission form.
 *
 * Ordered the way a creator thinks: which campaign, what did you post, when,
 * and here is the proof. The screenshot picker is last because it opens the
 * photo library and leaves the page on iOS — anything after it would be filled
 * in twice.
 */
export function SubmitFlow({
  campaigns,
  onSubmitted,
}: {
  campaigns: CampaignSummary[];
  onSubmitted: () => void;
}): ReactNode {
  const withWorkLeft = useMemo(
    () => campaigns.filter((c) => c.outstanding.some((o) => o.submitted < o.required)),
    [campaigns],
  );
  const choices = withWorkLeft.length > 0 ? withWorkLeft : campaigns;

  const [campaignId, setCampaignId] = useState(choices[0]?.id ?? '');
  const campaign = choices.find((c) => c.id === campaignId) ?? choices[0];

  const formatOptions: PostFormat[] = useMemo(() => {
    if (!campaign) return [];
    const owed = campaign.outstanding.filter((o) => o.submitted < o.required).map((o) => o.format);
    return owed.length > 0 ? owed : campaign.deliverableSpec.map((d) => d.format);
  }, [campaign]);

  const [format, setFormat] = useState<PostFormat | ''>('');
  const effectiveFormat = format || formatOptions[0] || '';

  const [postedAt, setPostedAt] = useState(() => toLocalInputValue(new Date()));
  const [publicUrl, setPublicUrl] = useState('');
  const [image, setImage] = useState<DownscaleResult | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const platform = campaign?.platforms[0] ?? 'instagram';
  const isStory = effectiveFormat === 'story';

  async function pickImage(file: File | undefined): Promise<void> {
    if (!file) return;
    setError(null);
    setStage('preparing');
    try {
      const result = await downscaleImage(file);
      if (image) URL.revokeObjectURL(image.previewUrl);
      setImage(result);
      setStage('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that image.');
      setStage('idle');
    }
  }

  const canSubmit =
    campaign != null && effectiveFormat !== '' && image != null && stage === 'idle';

  async function submit(): Promise<void> {
    if (!campaign || !image || effectiveFormat === '') return;
    setError(null);
    try {
      setStage('uploading');
      const presigned = await api.post<PresignResponse>('/api/creator/uploads/presign', {
        campaignId: campaign.id,
        contentType: image.contentType,
        byteLength: image.bytes,
      });
      await putToPresigned(presigned.uploadUrl, image.blob, image.contentType);

      setStage('submitting');
      await api.post('/api/creator/posts', {
        campaignId: campaign.id,
        platform,
        format: effectiveFormat,
        // A story has no permanent URL, so we do not pretend to want one.
        publicUrl: isStory || publicUrl.trim() === '' ? null : publicUrl.trim(),
        postedAt: new Date(postedAt).toISOString(),
        sourceImageKey: presigned.key,
      });

      setStage('done');
    } catch (err) {
      setStage('idle');
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    }
  }

  function reset(): void {
    if (image) URL.revokeObjectURL(image.previewUrl);
    setImage(null);
    setPublicUrl('');
    setPostedAt(toLocalInputValue(new Date()));
    setFormat('');
    setStage('idle');
    setError(null);
    if (fileInput.current) fileInput.current.value = '';
    onSubmitted();
  }

  if (choices.length === 0) {
    return (
      <Notice tone="info" title="Nothing to submit yet">
        You are not on an active campaign right now. We will message you in the community
        when there is one.
      </Notice>
    );
  }

  if (stage === 'done') {
    return (
      <div className="space-y-5">
        <Notice tone="success" title="Got it">
          We will read the numbers off your screenshot and check them. Nothing else for
          you to do.
        </Notice>
        <Button variant="secondary" onClick={reset} className="w-full">
          Submit another
        </Button>
      </div>
    );
  }

  const busy = stage !== 'idle';

  return (
    <div className="space-y-5">
      {choices.length > 1 ? (
        <Field label="Campaign">
          <select
            className={inputClass}
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setFormat('');
            }}
            disabled={busy}
          >
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <div>
          <p className="text-label text-muted">Campaign</p>
          <p className="font-medium">{campaign?.name}</p>
        </div>
      )}

      <Field label="What did you post?">
        <div className="grid grid-cols-2 gap-2">
          {formatOptions.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFormat(f)}
              disabled={busy}
              aria-pressed={effectiveFormat === f}
              className={`min-h-12 rounded-[--radius-lg] border px-4 font-medium transition-colors ${
                effectiveFormat === f
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-ink hover:bg-sunken'
              }`}
            >
              {FORMAT_LABELS[f]}
            </button>
          ))}
        </div>
      </Field>

      <Field label="When did it go live?">
        <input
          type="datetime-local"
          className={inputClass}
          value={postedAt}
          max={toLocalInputValue(new Date())}
          onChange={(e) => setPostedAt(e.target.value)}
          disabled={busy}
        />
      </Field>

      {!isStory ? (
        <Field label="Link to the post" hint="Optional, but it helps us match things up.">
          <input
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={inputClass}
            placeholder="https://…"
            value={publicUrl}
            onChange={(e) => setPublicUrl(e.target.value)}
            disabled={busy}
          />
        </Field>
      ) : null}

      <Field
        label="Screenshot of your Insights"
        hint="Open the post, tap View Insights, screenshot the whole panel. Make sure the numbers are all visible."
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void pickImage(e.target.files?.[0])}
        />
        {image ? (
          <div className="rounded-[--radius-lg] border border-line p-3">
            <img
              src={image.previewUrl}
              alt="The screenshot you are about to send"
              className="mx-auto max-h-64 rounded-[--radius-md]"
            />
            <p className="mt-3 text-center text-caption text-muted">
              {image.width}×{image.height} · {formatBytes(image.bytes)}
              {image.originalBytes > image.bytes
                ? ` (resized from ${formatBytes(image.originalBytes)})`
                : ''}
            </p>
            <Button
              variant="ghost"
              className="mt-1 w-full"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              Choose a different one
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            {stage === 'preparing' ? 'Preparing…' : 'Add screenshot'}
          </Button>
        )}
      </Field>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <div className="sticky bottom-0 -mx-5 border-t border-line bg-surface px-5 py-4">
        {busy && stage !== 'preparing' ? (
          <Spinner label={stage === 'uploading' ? 'Uploading screenshot…' : 'Sending…'} />
        ) : (
          <Button onClick={() => void submit()} disabled={!canSubmit} className="w-full">
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
