import { z } from 'zod';
import { EMPTY_METRICS, METRIC_KEYS, type MetricKey, type PostMetrics } from '../types/metrics.js';
import type { Platform } from '../types/common.js';
import { fieldConfidenceSchema, partialMetricsSchema } from './metrics.js';

/**
 * The contract with the vision model.
 *
 * Everything here assumes the model will eventually return something wrong:
 * prose around the JSON, a markdown fence, a metric key we never asked for,
 * a confidence of 1.5, a string "12.4K" instead of a number. Each of those is
 * handled explicitly below rather than trusted.
 */

export const screenTypeSchema = z.enum([
  'post_insights',
  'story_insights',
  'profile',
  'unrecognized',
]);

export const visionEnvelopeSchema = z.object({
  platform: z.enum(['instagram', 'tiktok', 'unknown']),
  screen_type: screenTypeSchema,
  /** Unknown keys are stripped, not rejected: a hallucinated field must not
   *  fail an otherwise good extraction, but must never reach the database. */
  metrics: partialMetricsSchema,
  field_confidence: fieldConfidenceSchema,
  notes: z.string().max(200).default(''),
});

export type VisionEnvelope = z.infer<typeof visionEnvelopeSchema>;

export interface VisionParseSuccess {
  readonly ok: true;
  readonly envelope: VisionEnvelope;
  /** Metrics widened to the full exhaustive shape, absent keys as null. */
  readonly metrics: PostMetrics;
  readonly fieldConfidence: Readonly<Partial<Record<MetricKey, number>>>;
  readonly warnings: readonly string[];
}

export interface VisionParseFailure {
  readonly ok: false;
  readonly error: string;
  readonly stage: 'empty' | 'json_syntax' | 'schema';
  readonly warnings: readonly string[];
}

export type VisionParseResult = VisionParseSuccess | VisionParseFailure;

/**
 * Strips the wrappers models habitually add: ```json fences, a leading
 * "Here is the JSON:", trailing commentary. Returns the largest balanced
 * top-level {...} span, which survives prose on both sides.
 */
export function extractJsonCandidate(raw: string): string | null {
  let text = raw.trim();
  if (text.length === 0) return null;

  // Strip fenced blocks, keeping the fence contents.
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Coerces the shapes a vision model plausibly emits for a count:
 * 12400 | "12400" | "12,400" | "12.4K" | "1.2M" | "" | "-" | "N/A" | null.
 * Anything it cannot read confidently becomes null, never a guess.
 *
 * Note "12.4K" resolves to 12400, which is genuinely lossy — the panel itself
 * only showed 3 significant figures. The prompt instructs the model to expand
 * abbreviations itself where the exact figure is visible; this is the fallback.
 */
export function coerceCount(input: unknown): { value: number | null; warning: string | null } {
  if (input === null || input === undefined) return { value: null, warning: null };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { value: null, warning: 'non-finite number' };
    if (!Number.isInteger(input)) {
      return { value: null, warning: `dropped non-integer count ${input}` };
    }
    return { value: input, warning: null };
  }
  if (typeof input !== 'string') return { value: null, warning: `unreadable count type` };

  const s = input.trim().replace(/,/g, '').replace(/\s+/g, '');
  if (s === '' || s === '-' || /^(n\/?a|null|none|unknown)$/i.test(s)) {
    return { value: null, warning: null };
  }
  const match = /^(-?\d+(?:\.\d+)?)([KkMmBb])?$/.exec(s);
  if (!match?.[1]) return { value: null, warning: `unreadable count "${input}"` };

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return { value: null, warning: `unreadable count "${input}"` };
  const multiplier = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ''] ?? 1;
  const scaled = base * multiplier;
  if (!Number.isInteger(scaled)) {
    return { value: Math.round(scaled), warning: `rounded abbreviated count "${input}"` };
  }
  return { value: scaled, warning: multiplier > 1 ? `expanded abbreviated count "${input}"` : null };
}

/**
 * The full defensive parse. Never throws. Every failure mode returns a typed
 * result carrying enough detail for the review queue to explain itself.
 */
export function parseVisionResponse(raw: string): VisionParseResult {
  const warnings: string[] = [];

  const candidate = extractJsonCandidate(raw);
  if (candidate === null) {
    return {
      ok: false,
      stage: 'empty',
      error: 'no JSON object found in model response',
      warnings,
    };
  }
  if (candidate !== raw.trim()) warnings.push('model wrapped its JSON in extra text or a code fence');

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err: unknown) {
    return {
      ok: false,
      stage: 'json_syntax',
      error: err instanceof Error ? err.message : 'unparseable JSON',
      warnings,
    };
  }

  // Pre-coerce metric values before zod sees them, so "12.4K" survives.
  if (typeof parsed === 'object' && parsed !== null && 'metrics' in parsed) {
    const metricsRaw = (parsed as { metrics: unknown }).metrics;
    if (typeof metricsRaw === 'object' && metricsRaw !== null) {
      const coerced: Record<string, number | null> = {};
      for (const [key, value] of Object.entries(metricsRaw as Record<string, unknown>)) {
        if (!(METRIC_KEYS as readonly string[]).includes(key)) {
          warnings.push(`model returned unknown metric "${key}"; dropped`);
          continue;
        }
        const { value: v, warning } = coerceCount(value);
        if (warning !== null) warnings.push(`${key}: ${warning}`);
        coerced[key] = v;
      }
      (parsed as { metrics: unknown }).metrics = coerced;
    }
  }

  const result = visionEnvelopeSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      stage: 'schema',
      error: result.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
      warnings,
    };
  }

  const envelope = result.data;
  const metrics: Record<MetricKey, number | null> = { ...EMPTY_METRICS };
  for (const key of METRIC_KEYS) {
    const value = envelope.metrics[key];
    metrics[key] = value ?? null;
  }

  const fieldConfidence: Partial<Record<MetricKey, number>> = {};
  for (const [key, confidence] of Object.entries(envelope.field_confidence)) {
    if (!(METRIC_KEYS as readonly string[]).includes(key)) continue;
    const metricKey = key as MetricKey;
    if (metrics[metricKey] === null && confidence > 0) {
      warnings.push(`${key}: confidence ${confidence} reported for a null value; treated as 0`);
      fieldConfidence[metricKey] = 0;
      continue;
    }
    fieldConfidence[metricKey] = confidence;
  }

  return { ok: true, envelope, metrics, fieldConfidence, warnings };
}

export function envelopePlatform(envelope: VisionEnvelope): Platform | null {
  return envelope.platform === 'unknown' ? null : envelope.platform;
}
