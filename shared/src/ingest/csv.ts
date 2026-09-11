/**
 * CSV parsing and column mapping.
 *
 * Pure. A brand exports orders from Shopify, WooCommerce, a spreadsheet, or
 * their accountant, and every one of those produces a slightly different file.
 * Everything here assumes the input is malformed until proven otherwise, and
 * reports what it could not read rather than guessing.
 */

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** 1-indexed line numbers of rows whose column count did not match the header. */
  readonly raggedRows: readonly { line: number; got: number; expected: number }[];
  readonly totalLines: number;
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvParseError';
  }
}

/** Longest single cell we will accept. A larger one is a malformed file. */
const MAX_CELL_LENGTH = 32_768;
const MAX_COLUMNS = 200;

/**
 * RFC 4180 parser, written out rather than pulled in.
 *
 * A dependency here would be reasonable, but this file is the boundary where
 * untrusted input enters the money path, and a hand-written parser whose exact
 * behaviour is pinned by tests is easier to reason about than a transitive one
 * whose quoting edge cases we would be trusting on faith.
 */
export function parseCsv(input: string): ParsedCsv {
  // Strip a UTF-8 BOM. Excel writes one; leaving it corrupts the first header.
  const text = input.replace(/^﻿/, '');
  if (text.trim().length === 0) throw new CsvParseError('the file is empty');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line += 1;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      line += 1;
      continue;
    }
    cell += ch;

    if (cell.length > MAX_CELL_LENGTH) {
      throw new CsvParseError(`a cell on line ${line} is longer than ${MAX_CELL_LENGTH} characters`);
    }
  }

  if (inQuotes) throw new CsvParseError('the file ends inside an unclosed quoted value');
  // A trailing newline leaves an empty cell; a final row without one does not.
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  const headerRow = rows.shift();
  if (!headerRow) throw new CsvParseError('the file has no header row');

  const headers = headerRow.map((h) => h.trim());
  if (headers.length > MAX_COLUMNS) {
    throw new CsvParseError(`the file has ${headers.length} columns; the limit is ${MAX_COLUMNS}`);
  }
  if (headers.every((h) => h.length === 0)) {
    throw new CsvParseError('the header row is blank');
  }

  /**
   * Duplicate headers are rejected rather than silently last-wins.
   *
   * Two columns called "Total" means the operator cannot know which one their
   * mapping selected, and the difference is money.
   */
  const seen = new Set<string>();
  for (const h of headers) {
    if (h.length === 0) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) throw new CsvParseError(`the header "${h}" appears more than once`);
    seen.add(key);
  }

  const ragged: { line: number; got: number; expected: number }[] = [];
  const objects: Record<string, string>[] = [];

  rows.forEach((cells, index) => {
    // Skip wholly blank lines — trailing newlines and stray separators are
    // extremely common and are not an error worth reporting.
    if (cells.every((c) => c.trim().length === 0)) return;

    if (cells.length !== headers.length) {
      ragged.push({ line: index + 2, got: cells.length, expected: headers.length });
      return;
    }
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      if (h.length > 0) obj[h] = (cells[i] ?? '').trim();
    });
    objects.push(obj);
  });

  return { headers, rows: objects, raggedRows: ragged, totalLines: rows.length + 1 };
}

/* ------------------------------------------------------------ value parsing */

/**
 * Parses a money string into integer minor units.
 *
 * Deliberately strict. A brand's export can contain "£1,234.50", "1234.5",
 * "1.234,50" (European), or "(12.00)" for a negative. Guessing between the
 * comma-as-thousands and comma-as-decimal conventions gets the amount wrong by
 * a factor of a thousand, so an ambiguous value is refused and reported rather
 * than interpreted.
 */
export function parseMoneyString(
  raw: string,
  minorUnitExponent: number,
): { ok: true; amountMinor: number } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // Accounting negatives: (12.00)
  let negative = false;
  let body = trimmed;
  if (/^\(.*\)$/.test(body)) {
    negative = true;
    body = body.slice(1, -1);
  }

  // Strip currency symbols and spaces, keep digits, separators and sign.
  body = body.replace(/[^\d.,\-+]/g, '');
  if (body.startsWith('-')) {
    negative = true;
    body = body.slice(1);
  } else if (body.startsWith('+')) {
    body = body.slice(1);
  }
  if (body.length === 0) return { ok: false, reason: `no digits in "${raw}"` };
  if (body.includes('-')) return { ok: false, reason: `misplaced minus sign in "${raw}"` };

  const commas = (body.match(/,/g) ?? []).length;
  const dots = (body.match(/\./g) ?? []).length;

  let normalised: string;

  if (commas > 0 && dots > 0) {
    // Whichever appears last is the decimal separator.
    normalised =
      body.lastIndexOf(',') > body.lastIndexOf('.')
        ? body.replace(/\./g, '').replace(',', '.')
        : body.replace(/,/g, '');
  } else if (commas > 1) {
    normalised = body.replace(/,/g, ''); // thousands only
  } else if (commas === 1) {
    const after = body.length - body.indexOf(',') - 1;
    if (after === 3) {
      // Genuinely ambiguous: "1,234" is either 1234 or 1.234 depending on
      // locale. Refuse rather than pick.
      return {
        ok: false,
        reason: `"${raw}" is ambiguous — a single comma with three digits after it could be thousands or a decimal`,
      };
    }
    normalised = body.replace(',', '.');
  } else if (dots > 1) {
    normalised = body.replace(/\./g, ''); // dots as thousands
  } else {
    normalised = body;
  }

  if (!/^\d*\.?\d*$/.test(normalised) || normalised === '.' || normalised.length === 0) {
    return { ok: false, reason: `"${raw}" is not a number` };
  }

  const [whole = '', fraction = ''] = normalised.split('.');
  if (fraction.length > minorUnitExponent) {
    return {
      ok: false,
      reason: `"${raw}" has ${fraction.length} decimal places; this currency has ${minorUnitExponent}`,
    };
  }

  const padded = fraction.padEnd(minorUnitExponent, '0');
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  const amountMinor = Number(digits === '' ? '0' : digits);

  if (!Number.isSafeInteger(amountMinor)) {
    return { ok: false, reason: `"${raw}" is too large to represent exactly` };
  }
  return { ok: true, amountMinor: negative ? -amountMinor : amountMinor };
}

/**
 * Parses a date from an export.
 *
 * ISO forms are taken as given. A bare DD/MM/YYYY or MM/DD/YYYY is refused:
 * 03/04/2026 is two different days depending on where the exporting shop is
 * configured, and silently picking one shifts orders across an attribution
 * window boundary.
 */
export function parseDateString(raw: string): { ok: true; date: Date } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(trimmed)) {
    return {
      ok: false,
      reason: `"${raw}" is ambiguous — export dates in ISO format (YYYY-MM-DD) so day and month cannot be swapped`,
    };
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return { ok: false, reason: `"${raw}" is not a date` };

  const year = date.getUTCFullYear();
  if (year < 2000 || year > 2100) {
    return { ok: false, reason: `"${raw}" resolves to ${year}, which is outside the plausible range` };
  }
  return { ok: true, date };
}

/* -------------------------------------------------------------- mapping */

export type OrderStatusLiteral = 'confirmed' | 'refunded' | 'partially_refunded' | 'cancelled';

/** Common status vocabularies, folded onto ours. */
const STATUS_SYNONYMS: Readonly<Record<string, OrderStatusLiteral>> = Object.freeze({
  paid: 'confirmed',
  complete: 'confirmed',
  completed: 'confirmed',
  fulfilled: 'confirmed',
  confirmed: 'confirmed',
  success: 'confirmed',
  refunded: 'refunded',
  'fully refunded': 'refunded',
  'partially refunded': 'partially_refunded',
  partial_refund: 'partially_refunded',
  partially_refunded: 'partially_refunded',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  voided: 'cancelled',
});

export function parseOrderStatus(raw: string): OrderStatusLiteral | null {
  const key = raw.trim().toLowerCase().replace(/-/g, '_');
  return STATUS_SYNONYMS[key] ?? STATUS_SYNONYMS[key.replace(/_/g, ' ')] ?? null;
}

export function parseCustomerType(raw: string): 'new' | 'returning' | 'unknown' {
  const key = raw.trim().toLowerCase();
  if (['new', 'first', 'first_time', 'first-time', 'true', '1'].includes(key)) return 'new';
  if (['returning', 'repeat', 'existing', 'false', '0'].includes(key)) return 'returning';
  return 'unknown';
}

/**
 * Guesses a column mapping from the headers.
 *
 * A starting point for the operator to correct, never applied silently — the
 * preview shows what the guess produced before anything is committed.
 */
export function guessMapping(headers: readonly string[]): Record<string, string | null> {
  const find = (...patterns: RegExp[]): string | null => {
    for (const p of patterns) {
      const hit = headers.find((h) => p.test(h.toLowerCase().trim()));
      if (hit) return hit;
    }
    return null;
  };

  return {
    externalOrderId: find(/^order.?(id|number|name|#)$/, /^id$/, /order/),
    orderedAt: find(/^(created|processed|ordered|order.?date|date)/, /date/),
    total: find(/^total$/, /grand.?total/, /^total.?price/, /amount/),
    subtotal: find(/^subtotal$/, /sub.?total/, /net/),
    currency: find(/^currency$/, /currency.?code/),
    discountCode: find(/discount.?code/, /coupon/, /promo/, /voucher/),
    customerType: find(/customer.?type/, /new.?customer/, /repeat/),
    status: find(/financial.?status/, /^status$/, /payment.?status/, /order.?status/),
    refundedAmount: find(/refund(ed)?.?amount/, /^refunded$/, /total.?refund/),
    refundedAt: find(/refund(ed)?.?(at|date)/),
  };
}
