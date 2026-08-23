import { describe, expect, it } from 'vitest';
import { coerceCount, extractJsonCandidate, parseVisionResponse } from './vision.js';

const GOOD = JSON.stringify({
  platform: 'instagram',
  screen_type: 'post_insights',
  metrics: { reach: 12400, impressions: 15900, likes: 842, comments: 37, shares: 21, saves: 156 },
  field_confidence: {
    reach: 0.97,
    impressions: 0.95,
    likes: 0.99,
    comments: 0.98,
    shares: 0.9,
    saves: 0.93,
  },
  notes: 'Clean Instagram reel insights panel.',
});

describe('extractJsonCandidate', () => {
  it('returns bare JSON unchanged', () => {
    expect(extractJsonCandidate('{"a":1}')).toBe('{"a":1}');
  });

  it('unwraps a json-labelled fence', () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('unwraps an unlabelled fence', () => {
    expect(extractJsonCandidate('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('strips prose before and after the object', () => {
    expect(extractJsonCandidate('Here you go:\n{"a":1}\nHope that helps!')).toBe('{"a":1}');
  });

  it('handles nested braces without truncating', () => {
    const nested = '{"a":{"b":{"c":1}},"d":2}';
    expect(extractJsonCandidate('noise ' + nested + ' noise')).toBe(nested);
  });

  it('is not fooled by braces inside strings', () => {
    const tricky = '{"notes":"a } brace","x":1}';
    expect(extractJsonCandidate(tricky)).toBe(tricky);
  });

  it('is not fooled by escaped quotes inside strings', () => {
    const tricky = JSON.stringify({ notes: 'he said "} }" loudly', x: 1 });
    expect(extractJsonCandidate(tricky)).toBe(tricky);
  });

  it('returns null for prose with no object', () => {
    expect(extractJsonCandidate('I cannot read this screenshot.')).toBeNull();
  });

  it('returns null for an unterminated object', () => {
    expect(extractJsonCandidate('{"a":1')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractJsonCandidate('   ')).toBeNull();
  });
});

describe('coerceCount', () => {
  it.each([
    [12400, 12400],
    ['12400', 12400],
    ['12,400', 12400],
    ['12.4K', 12400],
    ['1.2M', 1200000],
    ['3k', 3000],
    [0, 0],
    ['0', 0],
  ])('reads %o as %o', (input, expected) => {
    expect(coerceCount(input).value).toBe(expected);
  });

  it.each([null, undefined, '', '-', 'N/A', 'n/a', 'unknown'])('reads %o as null', (input) => {
    expect(coerceCount(input).value).toBeNull();
  });

  it('rejects a fractional raw number rather than rounding it', () => {
    const result = coerceCount(12.5);
    expect(result.value).toBeNull();
    expect(result.warning).toMatch(/non-integer/);
  });

  it('rejects unparseable strings', () => {
    expect(coerceCount('about twelve thousand').value).toBeNull();
    // Letter O rather than a zero: a plausible OCR slip that must not pass.
    expect(coerceCount('12,4OO').value).toBeNull();
  });

  it('rejects non-finite numbers', () => {
    expect(coerceCount(Number.POSITIVE_INFINITY).value).toBeNull();
    expect(coerceCount(Number.NaN).value).toBeNull();
  });

  it('warns when it expands an abbreviation, because precision was lost', () => {
    expect(coerceCount('12.4K').warning).toMatch(/expanded/);
  });
});

describe('parseVisionResponse', () => {
  it('parses a clean response and widens metrics to the full shape', () => {
    const result = parseVisionResponse(GOOD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.reach).toBe(12400);
    // Keys the model never mentioned are present and null, not absent.
    expect(result.metrics.linkClicks).toBeNull();
    expect(result.metrics.watchTimeSeconds).toBeNull();
    expect(Object.keys(result.metrics)).toHaveLength(11);
  });

  it('parses through a code fence and records a warning', () => {
    const result = parseVisionResponse('```json\n' + GOOD + '\n```');
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /code fence|extra text/.test(w))).toBe(true);
  });

  it('parses through leading prose', () => {
    expect(parseVisionResponse('Sure! Here is the JSON:\n' + GOOD).ok).toBe(true);
  });

  it('fails cleanly on empty output', () => {
    const result = parseVisionResponse('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('empty');
  });

  it('fails cleanly on a prose-only refusal', () => {
    const result = parseVisionResponse('I am sorry, I cannot help with that.');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('empty');
  });

  it('fails cleanly on truncated JSON', () => {
    const result = parseVisionResponse('{"platform":"instagram","metrics":{"reach":124');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // No balanced object exists, so this never reaches JSON.parse.
    expect(result.stage).toBe('empty');
  });

  it('fails cleanly on syntactically broken JSON', () => {
    const result = parseVisionResponse('{"platform":"instagram",,}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('json_syntax');
  });

  it('fails on schema violation rather than coercing a bad enum', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'youtube',
        screen_type: 'post_insights',
        metrics: {},
        field_confidence: {},
        notes: '',
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('schema');
    expect(result.error).toMatch(/platform/);
  });

  it('drops a hallucinated metric key and warns, without failing', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'tiktok',
        screen_type: 'post_insights',
        metrics: { reach: 900, totalAwesomeness: 42 },
        field_confidence: { reach: 0.9 },
        notes: '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => w.includes('totalAwesomeness'))).toBe(true);
    expect(Object.keys(result.metrics)).not.toContain('totalAwesomeness');
  });

  it('coerces abbreviated counts inside metrics', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'instagram',
        screen_type: 'post_insights',
        metrics: { reach: '12.4K', likes: '1,203' },
        field_confidence: { reach: 0.88, likes: 0.95 },
        notes: '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metrics.reach).toBe(12400);
    expect(result.metrics.likes).toBe(1203);
  });

  it('rejects a negative metric at the schema boundary', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'instagram',
        screen_type: 'post_insights',
        metrics: { reach: -5 },
        field_confidence: { reach: 0.9 },
        notes: '',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects a confidence outside 0..1', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'instagram',
        screen_type: 'post_insights',
        metrics: { reach: 100 },
        field_confidence: { reach: 1.5 },
        notes: '',
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('zeroes confidence reported against a null metric, and warns', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'instagram',
        screen_type: 'post_insights',
        metrics: { reach: 100, impressions: null },
        field_confidence: { reach: 0.9, impressions: 0.8 },
        notes: '',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fieldConfidence.impressions).toBe(0);
    expect(result.warnings.some((w) => w.includes('impressions'))).toBe(true);
  });

  it('rejects over-long notes rather than silently trimming them', () => {
    const result = parseVisionResponse(
      JSON.stringify({
        platform: 'instagram',
        screen_type: 'post_insights',
        metrics: {},
        field_confidence: {},
        notes: 'x'.repeat(201),
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    const nasty = ['', '{', '}', '[]', 'null', '{"metrics":null}', '{"metrics":"nope"}', ' '];
    for (const input of nasty) {
      expect(() => parseVisionResponse(input)).not.toThrow();
    }
  });
});
