import { describe, expect, it } from 'vitest';
import type { Money } from '../types/common.js';
import { CurrencyMismatchError } from './currency.js';
import { auditLedger, getBalance, runningBalance, type LedgerEntry } from './ledger.js';
import { calculateCommission, calculateReversal } from './commission.js';

const gbp = (amountMinor: number): Money => ({ amountMinor, currency: 'GBP' });
const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

const at = (iso: string): Date => new Date(iso);

function entry(
  type: LedgerEntry['type'],
  amountMinor: number,
  iso = '2026-09-01T00:00:00Z',
  currency = 'GBP',
): LedgerEntry {
  return { type, amount: { amountMinor, currency }, createdAt: at(iso) };
}

describe('getBalance', () => {
  it('is zero for an empty ledger, given a currency', () => {
    const b = getBalance([], 'GBP');
    expect(b.total).toEqual(gbp(0));
    expect(b.entryCount).toBe(0);
  });

  it('refuses to invent a currency for an empty ledger', () => {
    const b = getBalance([]);
    expect(b.total).toBeNull();
    expect(b.unavailableReason).toMatch(/no currency/);
  });

  it('sums a simple sequence of accruals', () => {
    const b = getBalance([entry('accrual', 500), entry('accrual', 300)]);
    expect(b.total).toEqual(gbp(800));
    expect(b.accrued).toEqual([gbp(800)]);
  });

  /**
   * The sequence the brief calls out: accrual, partial refund reversal, then a
   * manual adjustment. Every figure here comes from the commission engine
   * rather than being hand-written, so the test would catch the engine and the
   * ledger disagreeing.
   */
  it('balances accrual → partial refund → adjustment', () => {
    const { amount: accrued } = calculateCommission({
      basis: gbp(10_000),
      rateBps: 1000,
      rateBasis: 'order_total',
    });
    expect(accrued).toEqual(gbp(1_000));

    const reversal = calculateReversal({
      accrued,
      originalBasis: gbp(10_000),
      refunded: gbp(2_500),
    });
    expect(reversal.amount).toEqual(gbp(-250));

    const ledger: LedgerEntry[] = [
      { type: 'accrual', amount: accrued, createdAt: at('2026-09-01T10:00:00Z') },
      { type: 'reversal', amount: reversal.amount, createdAt: at('2026-09-05T10:00:00Z') },
      // Goodwill top-up agreed with the brand.
      { type: 'adjustment', amount: gbp(150), createdAt: at('2026-09-06T10:00:00Z') },
    ];

    const b = getBalance(ledger);
    expect(b.total).toEqual(gbp(900));
    expect(b.accrued).toEqual([gbp(1_000)]);
    expect(b.reversed).toEqual([gbp(-250)]);
    expect(b.adjusted).toEqual([gbp(150)]);
    expect(b.entryCount).toBe(3);
  });

  it('returns exactly zero after a full refund', () => {
    const { amount: accrued } = calculateCommission({
      basis: gbp(4_567),
      rateBps: 1000,
      rateBasis: 'order_total',
    });
    const reversal = calculateReversal({
      accrued,
      originalBasis: gbp(4_567),
      refunded: gbp(4_567),
    });
    const b = getBalance([
      { type: 'accrual', amount: accrued, createdAt: at('2026-09-01T00:00:00Z') },
      { type: 'reversal', amount: reversal.amount, createdAt: at('2026-09-02T00:00:00Z') },
    ]);
    expect(b.total).toEqual(gbp(0));
  });

  it('handles a negative balance from an over-adjustment', () => {
    // A creator can end up owing back, and the ledger must say so rather than
    // clamping at zero.
    const b = getBalance([entry('accrual', 100), entry('adjustment', -400)]);
    expect(b.total).toEqual(gbp(-300));
  });

  it('reports per currency rather than summing across them', () => {
    const b = getBalance([
      entry('accrual', 500, '2026-09-01T00:00:00Z', 'GBP'),
      entry('accrual', 700, '2026-09-02T00:00:00Z', 'USD'),
      entry('reversal', -100, '2026-09-03T00:00:00Z', 'GBP'),
    ]);
    expect(b.total).toBeNull();
    expect(b.unavailableReason).toMatch(/span 2 currencies/);
    expect(b.byCurrency).toEqual([gbp(400), usd(700)]);
  });

  it('a multi-currency ledger still breaks down by type', () => {
    const b = getBalance([
      entry('accrual', 500, '2026-09-01T00:00:00Z', 'GBP'),
      entry('accrual', 700, '2026-09-02T00:00:00Z', 'USD'),
    ]);
    expect(b.accrued).toEqual([gbp(500), usd(700)]);
  });

  it('is order-independent', () => {
    const entries = [entry('accrual', 500), entry('reversal', -200), entry('adjustment', 30)];
    const forward = getBalance(entries);
    const backward = getBalance([...entries].reverse());
    expect(forward.total).toEqual(backward.total);
  });
});

describe('runningBalance', () => {
  it('accumulates oldest first', () => {
    const rows = runningBalance([
      { type: 'adjustment', amount: gbp(30), createdAt: at('2026-09-03T00:00:00Z') },
      { type: 'accrual', amount: gbp(500), createdAt: at('2026-09-01T00:00:00Z') },
      { type: 'reversal', amount: gbp(-200), createdAt: at('2026-09-02T00:00:00Z') },
    ]);
    expect(rows.map((r) => r.balanceAfter.amountMinor)).toEqual([500, 300, 330]);
  });

  it('keeps a same-millisecond reversal after its accrual', () => {
    const t = '2026-09-01T00:00:00Z';
    const rows = runningBalance([
      { type: 'accrual', amount: gbp(500), createdAt: at(t) },
      { type: 'reversal', amount: gbp(-500), createdAt: at(t) },
    ]);
    expect(rows.map((r) => r.entry.type)).toEqual(['accrual', 'reversal']);
    expect(rows.at(-1)?.balanceAfter).toEqual(gbp(0));
  });

  it('refuses to run a multi-currency ledger', () => {
    expect(() =>
      runningBalance([
        entry('accrual', 500, '2026-09-01T00:00:00Z', 'GBP'),
        entry('accrual', 500, '2026-09-02T00:00:00Z', 'USD'),
      ]),
    ).toThrow(CurrencyMismatchError);
  });

  it('is empty for an empty ledger', () => {
    expect(runningBalance([])).toEqual([]);
  });
});

describe('auditLedger', () => {
  it('passes a well-formed ledger', () => {
    expect(
      auditLedger([entry('accrual', 500), entry('reversal', -200), entry('adjustment', -30)]).ok,
    ).toBe(true);
  });

  it('catches an accrual stored negative', () => {
    const r = auditLedger([entry('accrual', -500)]);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/accrual is negative/);
  });

  it('catches a reversal stored positive', () => {
    const r = auditLedger([entry('reversal', 500)]);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/reversal is positive/);
  });

  it('catches a fractional amount', () => {
    const r = auditLedger([entry('accrual', 500.5)]);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/fractional/);
  });

  it('allows a negative adjustment, which is legitimate', () => {
    expect(auditLedger([entry('adjustment', -250)]).ok).toBe(true);
  });
});
