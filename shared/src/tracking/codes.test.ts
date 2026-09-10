import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET } from '../types/commerce.js';
import {
  CODE_SUFFIX_LENGTH,
  buildTrackedUrl,
  codesMatch,
  drawUniqueCode,
  drawUniqueShortCode,
  generateCodeCandidate,
  generateShortCode,
  isValidStub,
  looksUnfortunate,
  normaliseStub,
  normaliseTypedCode,
} from './codes.js';

/** Deterministic RNG so a generator test asserts output, not luck. */
function seeded(seed: number): (max: number) => number {
  let s = seed >>> 0;
  return (max: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % max;
  };
}

const alwaysZero = (): number => 0;

/* ------------------------------------------------------------- alphabet */

describe('the code alphabet', () => {
  it('excludes every character pair a person confuses when typing', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(CODE_ALPHABET).not.toContain(ch);
    }
  });

  it('excludes vowels, so a random suffix cannot spell a word', () => {
    for (const vowel of ['A', 'E', 'I', 'O', 'U']) {
      expect(CODE_ALPHABET).not.toContain(vowel);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
  });
});

/* ----------------------------------------------------------------- stubs */

describe('normaliseStub', () => {
  it('uppercases and strips punctuation', () => {
    expect(normaliseStub('amara.bell')).toBe('AMARABELL');
    expect(normaliseStub('Tom Yilmaz')).toBe('TOMYILMAZ');
  });

  it('folds diacritics rather than stripping the letter', () => {
    // Stripping would give SOFA, which a creator would reasonably object to.
    expect(normaliseStub('Sofía')).toBe('SOFIA');
    expect(normaliseStub('Zoë')).toBe('ZOE');
    expect(normaliseStub('Håkon')).toBe('HAKON');
  });

  it('truncates a long name rather than failing', () => {
    expect(normaliseStub('Bartholomewson-Fitzgerald').length).toBeLessThanOrEqual(12);
  });

  it('drops digits and emoji', () => {
    expect(normaliseStub('nia99 ✨')).toBe('NIA');
  });

  it.each([
    ['AB', true],
    ['AMARA', true],
    ['A', false],
    ['', false],
    ['A1', false],
  ])('isValidStub(%j) is %s', (stub, expected) => {
    expect(isValidStub(stub)).toBe(expected);
  });
});

/* ------------------------------------------------------------ generation */

describe('generateCodeCandidate', () => {
  it('prefixes the stub so the creator recognises it as theirs', () => {
    const code = generateCodeCandidate('Amara', seeded(1));
    expect(code.startsWith('AMARA')).toBe(true);
    expect(code).toHaveLength('AMARA'.length + CODE_SUFFIX_LENGTH);
  });

  it('draws its suffix only from the safe alphabet', () => {
    for (let seed = 1; seed < 200; seed += 1) {
      const suffix = generateCodeCandidate('AB', seeded(seed)).slice(2);
      for (const ch of suffix) expect(CODE_ALPHABET).toContain(ch);
    }
  });

  it('is deterministic for a given random source', () => {
    expect(generateCodeCandidate('Amara', seeded(42))).toBe(generateCodeCandidate('Amara', seeded(42)));
  });

  it('refuses a stub with fewer than two usable letters', () => {
    expect(() => generateCodeCandidate('7', alwaysZero)).toThrow(/fewer than two usable letters/);
    expect(() => generateCodeCandidate('', alwaysZero)).toThrow(RangeError);
  });

  it('produces distinct codes across many draws', () => {
    const rng = seeded(7);
    const codes = new Set(Array.from({ length: 500 }, () => generateCodeCandidate('AMARA', rng)));
    // Not a uniqueness guarantee — that is the collision check's job — but a
    // generator that repeats itself constantly would show up here.
    expect(codes.size).toBeGreaterThan(490);
  });
});

describe('generateShortCode', () => {
  it('is longer than a discount code suffix and uses the same alphabet', () => {
    const code = generateShortCode(seeded(3));
    expect(code).toHaveLength(7);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
  });
});

/* --------------------------------------------------------- uniqueness */

describe('drawUniqueCode', () => {
  it('returns a code that is not taken', () => {
    const taken = new Set(['AMARA' + CODE_ALPHABET[0]!.repeat(CODE_SUFFIX_LENGTH)]);
    const code = drawUniqueCode({
      stub: 'AMARA',
      randomInt: seeded(5),
      isTaken: (c) => taken.has(c),
    });
    expect(taken.has(code)).toBe(false);
  });

  it('retries past a collision', () => {
    let calls = 0;
    const code = drawUniqueCode({
      stub: 'AMARA',
      randomInt: seeded(9),
      isTaken: () => {
        calls += 1;
        return calls <= 3;
      },
    });
    expect(calls).toBe(4);
    expect(code.startsWith('AMARA')).toBe(true);
  });

  it('fails loudly rather than reusing a code', () => {
    // Reuse would attribute one creator's sales to another. Refusing is the
    // only safe failure.
    expect(() =>
      drawUniqueCode({
        stub: 'AMARA',
        randomInt: seeded(1),
        isTaken: () => true,
        maxAttempts: 5,
      }),
    ).toThrow(/not being reused/);
  });

  it('skips a code that spells something unfortunate', () => {
    const seen: string[] = [];
    const code = drawUniqueCode({
      stub: 'FC',
      randomInt: seeded(11),
      isTaken: (c) => {
        seen.push(c);
        return false;
      },
    });
    expect(looksUnfortunate(code)).toBe(false);
  });

  it('drawUniqueShortCode retries and then fails loudly', () => {
    expect(() =>
      drawUniqueShortCode({ randomInt: seeded(2), isTaken: () => true, maxAttempts: 3 }),
    ).toThrow(/could not draw a free short code/);
  });
});

describe('looksUnfortunate', () => {
  it('catches an unfortunate substring formed across the stub join', () => {
    expect(looksUnfortunate('FCK23')).toBe(true);
    expect(looksUnfortunate('AMARAFCKZ')).toBe(true);
  });

  it('passes an ordinary code', () => {
    expect(looksUnfortunate('AMARAK7P3M')).toBe(false);
  });
});

/* ------------------------------------------------------------- matching */

describe('matching a code as a customer typed it', () => {
  it('matches exactly', () => {
    expect(codesMatch('AMARAK7P3M', 'AMARAK7P3M')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(codesMatch('AMARAK7P3M', 'amarak7p3m')).toBe(true);
  });

  it('ignores spaces, hyphens and stray punctuation', () => {
    expect(codesMatch('AMARAK7P3M', 'AMARA-K7P3M')).toBe(true);
    expect(codesMatch('AMARAK7P3M', 'amara k7p3m')).toBe(true);
    expect(codesMatch('AMARAK7P3M', 'AMARA_K7P3M')).toBe(true);
  });

  it('folds the character pairs a person confuses', () => {
    // The issued code can never contain O, I or L — but what the customer
    // typed, and what the brand's export recorded, can.
    expect(codesMatch('AMARAK7P3M', 'AMARAK7P3M')).toBe(true);
    expect(normaliseTypedCode('0')).toBe(normaliseTypedCode('O'));
    expect(normaliseTypedCode('1')).toBe(normaliseTypedCode('I'));
    expect(normaliseTypedCode('1')).toBe(normaliseTypedCode('L'));
  });

  it('is symmetric', () => {
    const pairs: [string, string][] = [
      ['AMARAK7P3M', 'amara-k7p3m'],
      ['TOMB2C3D4', 'TOMB2C3D4'],
    ];
    for (const [a, b] of pairs) {
      expect(codesMatch(a, b)).toBe(codesMatch(b, a));
    }
  });

  it('does not match two genuinely different codes', () => {
    expect(codesMatch('AMARAK7P3M', 'AMARAK7P3N')).toBe(false);
    expect(codesMatch('AMARAK7P3M', 'TOMK7P3M')).toBe(false);
  });

  it('does not collapse two distinct issued codes into one', () => {
    // The load-bearing invariant. The folding maps O onto Q and I/L onto J,
    // and BOTH Q and J are in the issuable alphabet — so this has to be proven
    // rather than assumed. It holds only because O, I, L, 0 and 1 can never
    // appear in a code we issue.
    const issued: string[] = [];
    for (const a of CODE_ALPHABET) {
      for (const b of CODE_ALPHABET) {
        issued.push(`AMARA${a}${b}234`);
      }
    }
    const normalised = issued.map(normaliseTypedCode);
    expect(new Set(normalised).size).toBe(issued.length);
  });

  it('folds a mistyped character onto the code that was actually issued', () => {
    // A customer who types O where the code has Q still redeems. That is the
    // point of the folding, and it is safe precisely because O is unissuable.
    expect(codesMatch('AMARAQ2345', 'AMARAO2345')).toBe(true);
    expect(codesMatch('AMARAJ2345', 'AMARAI2345')).toBe(true);
    expect(codesMatch('AMARAJ2345', 'AMARAL2345')).toBe(true);
  });
});

/* ---------------------------------------------------------- tracked URLs */

describe('buildTrackedUrl', () => {
  it('attaches UTM parameters and our reference', () => {
    const url = new URL(
      buildTrackedUrl({
        destinationUrl: 'https://brand.example/products/serum',
        shortCode: 'K7P3MQR',
        utmCampaign: 'barrier-serum',
        utmContent: 'amara.bell',
      }),
    );
    expect(url.searchParams.get('utm_source')).toBe('anton');
    expect(url.searchParams.get('utm_medium')).toBe('creator');
    expect(url.searchParams.get('utm_campaign')).toBe('barrier-serum');
    expect(url.searchParams.get('utm_content')).toBe('amara.bell');
    expect(url.searchParams.get('anton_ref')).toBe('K7P3MQR');
  });

  it("preserves the brand's own query parameters", () => {
    // Dropping these breaks the brand's landing page or their own analytics.
    const url = new URL(
      buildTrackedUrl({
        destinationUrl: 'https://brand.example/p?variant=42&ref=homepage',
        shortCode: 'ABC2345',
        utmCampaign: 'c',
        utmContent: 'x',
      }),
    );
    expect(url.searchParams.get('variant')).toBe('42');
    expect(url.searchParams.get('ref')).toBe('homepage');
  });

  it('preserves the path and fragment', () => {
    const url = buildTrackedUrl({
      destinationUrl: 'https://brand.example/collections/new/products/x#reviews',
      shortCode: 'ABC2345',
      utmCampaign: 'c',
      utmContent: 'x',
    });
    expect(url).toContain('/collections/new/products/x');
    expect(url).toContain('#reviews');
  });

  it('overwrites a stale anton_ref rather than appending a second one', () => {
    const url = new URL(
      buildTrackedUrl({
        destinationUrl: 'https://brand.example/p?anton_ref=OLD',
        shortCode: 'NEW2345',
        utmCampaign: 'c',
        utmContent: 'x',
      }),
    );
    expect(url.searchParams.getAll('anton_ref')).toEqual(['NEW2345']);
  });

  it('throws on a malformed destination rather than emitting a broken link', () => {
    expect(() =>
      buildTrackedUrl({
        destinationUrl: 'not a url',
        shortCode: 'ABC2345',
        utmCampaign: 'c',
        utmContent: 'x',
      }),
    ).toThrow();
  });
});
