import { describe, expect, it } from 'vitest';
import {
  CsvParseError,
  guessMapping,
  parseCsv,
  parseCustomerType,
  parseDateString,
  parseMoneyString,
  parseOrderStatus,
} from './csv.js';
import { mapRow, mapRows } from './map.js';
import type { ColumnMapping } from '../schemas/commerce.js';

/* ------------------------------------------------------------- parsing */

describe('parseCsv', () => {
  it('parses a simple file', () => {
    const r = parseCsv('id,total\nA1,10.00\nA2,20.00\n');
    expect(r.headers).toEqual(['id', 'total']);
    expect(r.rows).toEqual([
      { id: 'A1', total: '10.00' },
      { id: 'A2', total: '20.00' },
    ]);
  });

  it('handles a file with no trailing newline', () => {
    expect(parseCsv('id,total\nA1,10.00').rows).toHaveLength(1);
  });

  it('handles CRLF', () => {
    const r = parseCsv('id,total\r\nA1,10.00\r\n');
    expect(r.rows[0]).toEqual({ id: 'A1', total: '10.00' });
  });

  it('strips a UTF-8 BOM, which Excel writes', () => {
    // Left in place, the BOM corrupts the first header and every mapping onto it.
    const r = parseCsv('﻿id,total\nA1,10.00\n');
    expect(r.headers[0]).toBe('id');
  });

  it('handles quoted fields with embedded commas', () => {
    const r = parseCsv('id,note\nA1,"Bell, Amara"\n');
    expect(r.rows[0]?.note).toBe('Bell, Amara');
  });

  it('handles escaped quotes', () => {
    const r = parseCsv('id,note\nA1,"she said ""hi"""\n');
    expect(r.rows[0]?.note).toBe('she said "hi"');
  });

  it('handles a newline inside a quoted field', () => {
    const r = parseCsv('id,note\nA1,"line one\nline two"\nA2,x\n');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.note).toBe('line one\nline two');
  });

  it('trims surrounding whitespace on values', () => {
    expect(parseCsv('id,total\n A1 , 10.00 \n').rows[0]).toEqual({ id: 'A1', total: '10.00' });
  });

  it('skips wholly blank lines without reporting them', () => {
    const r = parseCsv('id,total\nA1,10.00\n\n\nA2,20.00\n');
    expect(r.rows).toHaveLength(2);
    expect(r.raggedRows).toHaveLength(0);
  });

  it('reports a ragged row with its line number rather than guessing', () => {
    const r = parseCsv('id,total,note\nA1,10.00\nA2,20.00,ok\n');
    expect(r.rows).toHaveLength(1);
    expect(r.raggedRows).toEqual([{ line: 2, got: 2, expected: 3 }]);
  });

  it('rejects an unclosed quote rather than silently truncating', () => {
    expect(() => parseCsv('id,note\nA1,"never closed\n')).toThrow(/unclosed quoted value/);
  });

  it('rejects duplicate headers', () => {
    // Two columns called Total means the operator cannot know which their
    // mapping picked, and the difference is money.
    expect(() => parseCsv('id,Total,total\nA1,1,2\n')).toThrow(/appears more than once/);
  });

  it('rejects an empty file and a blank header row', () => {
    expect(() => parseCsv('')).toThrow(CsvParseError);
    expect(() => parseCsv('   ')).toThrow(CsvParseError);
    expect(() => parseCsv(',,\nA1,1,2\n')).toThrow(/header row is blank/);
  });

  it('does not treat a quote mid-value as a quoted field', () => {
    expect(parseCsv('id,note\nA1,5" pipe\n').rows[0]?.note).toBe('5" pipe');
  });
});

/* --------------------------------------------------------------- money */

describe('parseMoneyString', () => {
  it.each([
    ['10.00', 1000],
    ['10.5', 1050],
    ['10', 1000],
    ['0.01', 1],
    ['0', 0],
    ['£1234.56', 123_456],
    ['$1,234.56', 123_456],
    ['1.234,56', 123_456],
    ['12,50', 1250],
    ['  42.00  ', 4200],
  ])('reads %s as %d minor units', (raw, expected) => {
    const r = parseMoneyString(raw, 2);
    expect(r.ok && r.amountMinor).toBe(expected);
  });

  it('reads an accounting negative', () => {
    const r = parseMoneyString('(12.00)', 2);
    expect(r.ok && r.amountMinor).toBe(-1200);
  });

  it('reads a leading-minus negative', () => {
    const r = parseMoneyString('-12.00', 2);
    expect(r.ok && r.amountMinor).toBe(-1200);
  });

  it('refuses a genuinely ambiguous thousand separator', () => {
    // "1,234" is 1234 or 1.234 depending on locale. Getting it wrong is a
    // 1000x error on a figure someone is paid against.
    const r = parseMoneyString('1,234', 2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/ambiguous/);
  });

  it('refuses more decimal places than the currency has', () => {
    const r = parseMoneyString('10.005', 2);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/decimal places/);
  });

  it('handles a zero-exponent currency', () => {
    // JPY 100 is 100 minor units, not 10000.
    const r = parseMoneyString('100', 0);
    expect(r.ok && r.amountMinor).toBe(100);
    expect(parseMoneyString('100.5', 0).ok).toBe(false);
  });

  it('handles a three-exponent currency', () => {
    const r = parseMoneyString('1.234', 3);
    expect(r.ok && r.amountMinor).toBe(1234);
  });

  it.each(['', '   ', 'abc', '£', '--5', '.'])('refuses %j', (raw) => {
    expect(parseMoneyString(raw, 2).ok).toBe(false);
  });

  it('never returns a fractional minor amount', () => {
    for (const raw of ['10.00', '0.01', '999.99', '1.234,56', '(0.05)']) {
      const r = parseMoneyString(raw, 2);
      if (r.ok) expect(Number.isInteger(r.amountMinor)).toBe(true);
    }
  });
});

/* ---------------------------------------------------------------- dates */

describe('parseDateString', () => {
  it('accepts ISO forms', () => {
    expect(parseDateString('2026-09-01').ok).toBe(true);
    expect(parseDateString('2026-09-01T10:30:00Z').ok).toBe(true);
    expect(parseDateString('2026-09-01 10:30:00 +0100').ok).toBe(true);
  });

  it('refuses an ambiguous slash date', () => {
    // 03/04/2026 is two different days depending on the shop's locale, and the
    // difference can move an order across an attribution window boundary.
    const r = parseDateString('03/04/2026');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/ambiguous/);
    expect(parseDateString('3-4-26').ok).toBe(false);
  });

  it('refuses nonsense and implausible years', () => {
    expect(parseDateString('yesterday').ok).toBe(false);
    expect(parseDateString('1970-01-01').ok).toBe(false);
  });
});

/* -------------------------------------------------------------- statuses */

describe('status and customer type', () => {
  it.each([
    ['paid', 'confirmed'],
    ['Fulfilled', 'confirmed'],
    ['refunded', 'refunded'],
    ['partially refunded', 'partially_refunded'],
    ['partially_refunded', 'partially_refunded'],
    ['canceled', 'cancelled'],
    ['voided', 'cancelled'],
  ])('reads status %j as %s', (raw, expected) => {
    expect(parseOrderStatus(raw)).toBe(expected);
  });

  it('returns null for an unrecognised status rather than assuming confirmed', () => {
    expect(parseOrderStatus('pending_authorisation')).toBeNull();
  });

  it('reads customer type, defaulting to unknown', () => {
    expect(parseCustomerType('new')).toBe('new');
    expect(parseCustomerType('Repeat')).toBe('returning');
    expect(parseCustomerType('')).toBe('unknown');
    expect(parseCustomerType('???')).toBe('unknown');
  });
});

/* -------------------------------------------------------------- guessing */

describe('guessMapping', () => {
  it('recognises a Shopify-style export', () => {
    const g = guessMapping([
      'Name',
      'Created at',
      'Total',
      'Subtotal',
      'Currency',
      'Discount Code',
      'Financial Status',
    ]);
    expect(g.orderedAt).toBe('Created at');
    expect(g.total).toBe('Total');
    expect(g.subtotal).toBe('Subtotal');
    expect(g.currency).toBe('Currency');
    expect(g.discountCode).toBe('Discount Code');
    expect(g.status).toBe('Financial Status');
  });

  it('returns null for a field it cannot find', () => {
    expect(guessMapping(['a', 'b']).total).toBeNull();
  });
});

/* -------------------------------------------------------------- mapping */

const mapping: ColumnMapping = {
  externalOrderId: 'id',
  orderedAt: 'date',
  total: 'total',
  subtotal: 'subtotal',
  currency: 'currency',
  discountCode: 'code',
  customerType: null,
  status: 'status',
  refundedAmount: 'refunded',
  refundedAt: null,
  fallbackCurrency: 'GBP',
};

const row = (over: Record<string, string> = {}): Record<string, string> => ({
  id: 'A1',
  date: '2026-09-01',
  total: '100.00',
  subtotal: '90.00',
  currency: 'GBP',
  code: 'AMARA23456',
  status: 'paid',
  refunded: '',
  ...over,
});

describe('mapRow', () => {
  it('maps a clean row', () => {
    const r = mapRow(row(), mapping, 2);
    expect(r.ok).toBe(true);
    expect(r.order?.total).toEqual({ amountMinor: 10_000, currency: 'GBP' });
    expect(r.order?.subtotal).toEqual({ amountMinor: 9_000, currency: 'GBP' });
    expect(r.order?.discountCodeUsed).toBe('AMARA23456');
    expect(r.order?.status).toBe('confirmed');
  });

  it('falls back to the total when there is no subtotal column', () => {
    const r = mapRow(row({ subtotal: '' }), mapping, 2);
    expect(r.order?.subtotal).toEqual(r.order?.total);
  });

  it('falls back to the mapping currency when the row has none', () => {
    const r = mapRow(row({ currency: '' }), mapping, 2);
    expect(r.order?.total.currency).toBe('GBP');
  });

  it('uses the row currency over the fallback', () => {
    const r = mapRow(row({ currency: 'EUR' }), mapping, 2);
    expect(r.order?.total.currency).toBe('EUR');
  });

  it('derives a refunded status from a refund amount on a row marked paid', () => {
    // Exports disagree with themselves constantly. The amount is what a
    // reversal is computed from, so it wins.
    const partial = mapRow(row({ refunded: '25.00' }), mapping, 2);
    expect(partial.order?.status).toBe('partially_refunded');
    expect(partial.order?.refundedAmount).toEqual({ amountMinor: 2_500, currency: 'GBP' });

    const full = mapRow(row({ refunded: '100.00' }), mapping, 2);
    expect(full.order?.status).toBe('refunded');
  });

  it('fills a full refund amount when the status says refunded but no figure is given', () => {
    const r = mapRow(row({ status: 'refunded', refunded: '' }), mapping, 2);
    expect(r.order?.refundedAmount).toEqual({ amountMinor: 10_000, currency: 'GBP' });
  });

  it('refuses a partial refund with no amount, which cannot be computed', () => {
    const r = mapRow(row({ status: 'partially refunded', refunded: '' }), mapping, 2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no refund amount/);
  });

  it.each([
    [{ id: '' }, /no order id/],
    [{ date: '03/04/2026' }, /ambiguous/],
    [{ total: 'abc' }, /total/],
    [{ subtotal: '200.00' }, /greater than total/],
    [{ status: 'weird' }, /was not recognised/],
    [{ currency: 'POUNDS' }, /three-letter ISO/],
  ])('rejects %o with a reason an ops person can act on', (over, pattern) => {
    const r = mapRow(row(over), mapping, 7);
    expect(r.ok).toBe(false);
    expect(r.line).toBe(7);
    expect(r.reason).toMatch(pattern);
  });

  it('keeps the raw row verbatim, including a formula payload', () => {
    const raw = row({ note: '=cmd()' } as Record<string, string>);
    const r = mapRow(raw, mapping, 2);
    // Neutralisation happens on export; the stored record stays faithful.
    expect(r.order?.rawRow).toEqual(raw);
  });
});

describe('mapRows', () => {
  it('summarises a file', () => {
    const report = mapRows(
      [row({ id: 'A1' }), row({ id: 'A2', date: '2026-09-10' }), row({ id: '', total: 'x' })],
      mapping,
    );
    expect(report.rowsParsed).toBe(2);
    expect(report.rowsSkipped).toBe(1);
    expect(report.skipped[0]?.line).toBe(4);
    expect(report.dateRangeFrom?.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(report.dateRangeTo?.toISOString().slice(0, 10)).toBe('2026-09-10');
    expect(report.currencies).toEqual(['GBP']);
  });

  it('keeps the last of a duplicated id and reports the duplicate', () => {
    // Exports append a corrected row rather than editing in place, so the later
    // row is the brand's most recent statement about that order.
    const report = mapRows([row({ id: 'A1', total: '100.00' }), row({ id: 'A1', total: '150.00' })], mapping);
    expect(report.rowsParsed).toBe(1);
    expect(report.orders[0]?.total.amountMinor).toBe(15_000);
    expect(report.duplicatesInFile).toEqual([{ externalOrderId: 'A1', lines: [2, 3] }]);
  });

  it('reports every currency present so a mixed file is visible before commit', () => {
    const report = mapRows(
      [row({ id: 'A1', currency: 'GBP' }), row({ id: 'A2', currency: 'USD' })],
      mapping,
    );
    expect(report.currencies).toEqual(['GBP', 'USD']);
  });

  it('is empty-safe', () => {
    const report = mapRows([], mapping);
    expect(report.rowsParsed).toBe(0);
    expect(report.dateRangeFrom).toBeNull();
  });
});
