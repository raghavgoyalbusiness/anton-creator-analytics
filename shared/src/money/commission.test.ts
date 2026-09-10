import { describe, expect, it } from 'vitest';
import type { Money } from '../types/common.js';
import {
  CurrencyMismatchError,
  formatMoney,
  roundHalfAwayFromZero,
  sumByCurrency,
  sumMoney,
} from './currency.js';
import {
  BPS_PER_UNIT,
  bpsFromPercent,
  calculateCommission,
  calculateReversal,
  isValidRate,
  outstandingReversal,
  percentFromBps,
  selectBasis,
} from './commission.js';

const gbp = (amountMinor: number): Money => ({ amountMinor, currency: 'GBP' });
const usd = (amountMinor: number): Money => ({ amountMinor, currency: 'USD' });

/* --------------------------------------------------------------- rounding */

describe('roundHalfAwayFromZero', () => {
  it.each([
    [0.5, 1],
    [1.5, 2],
    [2.5, 3],
    [0.4, 0],
    [0.6, 1],
    [0, 0],
  ])('rounds %d to %d', (input, expected) => {
    expect(roundHalfAwayFromZero(input)).toBe(expected);
  });

  it('is symmetric about zero, unlike Math.round', () => {
    // Math.round(-0.5) is -0, which breaks reversal/accrual cancellation.
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(-1.5)).toBe(-2);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    for (const v of [0.5, 1.5, 2.5, 3.7, 0.1]) {
      expect(roundHalfAwayFromZero(-v)).toBe(-roundHalfAwayFromZero(v));
    }
  });
});

/* ------------------------------------------------------------------ rates */

describe('rates as basis points', () => {
  it('converts percentages both ways', () => {
    expect(bpsFromPercent(10)).toBe(1000);
    expect(bpsFromPercent(12.5)).toBe(1250);
    expect(bpsFromPercent(0)).toBe(0);
    expect(bpsFromPercent(100)).toBe(10_000);
    expect(percentFromBps(1250)).toBe(12.5);
  });

  it('rejects a rate finer than a basis point', () => {
    // 0.005% cannot be represented; better to refuse than silently truncate.
    expect(() => bpsFromPercent(0.005)).toThrow(/finer than a basis point/);
  });

  it.each([
    [0, true],
    [1, true],
    [10_000, true],
    [10_001, false],
    [-1, false],
    [1000.5, false],
  ])('isValidRate(%d) is %s', (bps, expected) => {
    expect(isValidRate(bps)).toBe(expected);
  });
});

/* ------------------------------------------------------------- commission */

describe('calculateCommission', () => {
  it('computes a plain percentage', () => {
    const r = calculateCommission({ basis: gbp(10_000), rateBps: 1000, rateBasis: 'order_total' });
    expect(r.amount).toEqual(gbp(1_000));
  });

  it('rounds at a fractional penny, half away from zero', () => {
    // 10% of 4567 = 456.7 → 457
    expect(
      calculateCommission({ basis: gbp(4_567), rateBps: 1000, rateBasis: 'order_total' }).amount,
    ).toEqual(gbp(457));

    // 50% of 1 = 0.5 → 1 (exactly half, rounds up)
    expect(
      calculateCommission({ basis: gbp(1), rateBps: 5_000, rateBasis: 'order_total' }).amount,
    ).toEqual(gbp(1));

    // 50% of 3 = 1.5 → 2
    expect(
      calculateCommission({ basis: gbp(3), rateBps: 5_000, rateBasis: 'order_total' }).amount,
    ).toEqual(gbp(2));

    // 10% of 4564 = 456.4 → 456 (rounds down)
    expect(
      calculateCommission({ basis: gbp(4_564), rateBps: 1000, rateBasis: 'order_total' }).amount,
    ).toEqual(gbp(456));
  });

  it('returns exactly zero at a zero rate', () => {
    const r = calculateCommission({ basis: gbp(99_999), rateBps: 0, rateBasis: 'order_total' });
    expect(r.amount).toEqual(gbp(0));
  });

  it('returns exactly the basis at a 100% rate', () => {
    const r = calculateCommission({
      basis: gbp(12_345),
      rateBps: BPS_PER_UNIT,
      rateBasis: 'order_total',
    });
    expect(r.amount).toEqual(gbp(12_345));
  });

  it('carries the basis currency through, whatever it is', () => {
    expect(
      calculateCommission({ basis: usd(10_000), rateBps: 1000, rateBasis: 'order_total' }).amount
        .currency,
    ).toBe('USD');
    expect(
      calculateCommission({
        basis: { amountMinor: 10_000, currency: 'JPY' },
        rateBps: 1000,
        rateBasis: 'order_total',
      }).amount.currency,
    ).toBe('JPY');
  });

  it('never produces a fractional amount, across a wide sweep', () => {
    for (let basis = 0; basis < 400; basis += 7) {
      for (const rateBps of [0, 1, 250, 333, 1000, 1250, 5000, 9999, 10_000]) {
        const { amount } = calculateCommission({
          basis: gbp(basis),
          rateBps,
          rateBasis: 'order_total',
        });
        expect(Number.isInteger(amount.amountMinor)).toBe(true);
        expect(amount.amountMinor).toBeGreaterThanOrEqual(0);
        expect(amount.amountMinor).toBeLessThanOrEqual(basis);
      }
    }
  });

  it('rejects an out-of-range rate rather than clamping it', () => {
    expect(() =>
      calculateCommission({ basis: gbp(100), rateBps: 10_001, rateBasis: 'order_total' }),
    ).toThrow(RangeError);
    expect(() =>
      calculateCommission({ basis: gbp(100), rateBps: -1, rateBasis: 'order_total' }),
    ).toThrow(RangeError);
  });

  it('rejects a fractional basis', () => {
    expect(() =>
      calculateCommission({ basis: gbp(100.5), rateBps: 1000, rateBasis: 'order_total' }),
    ).toThrow(RangeError);
  });

  it('shows its workings so the arithmetic is never a black box', () => {
    const r = calculateCommission({ basis: gbp(4_567), rateBps: 1250, rateBasis: 'order_subtotal' });
    expect(r.workings).toContain('12.5%');
    expect(r.workings).toContain('order subtotal');
    expect(r.workings).toContain('571');
  });

  it('selects the basis the rate applies to', () => {
    const order = { subtotal: gbp(9_000), total: gbp(10_000) };
    expect(selectBasis(order, 'order_subtotal')).toEqual(gbp(9_000));
    expect(selectBasis(order, 'order_total')).toEqual(gbp(10_000));
  });

  it('subtotal and total give different commission, as they must', () => {
    const order = { subtotal: gbp(9_000), total: gbp(10_000) };
    const onSub = calculateCommission({
      basis: selectBasis(order, 'order_subtotal'),
      rateBps: 1000,
      rateBasis: 'order_subtotal',
    });
    const onTotal = calculateCommission({
      basis: selectBasis(order, 'order_total'),
      rateBps: 1000,
      rateBasis: 'order_total',
    });
    expect(onSub.amount).toEqual(gbp(900));
    expect(onTotal.amount).toEqual(gbp(1_000));
  });
});

/* -------------------------------------------------------------- reversals */

describe('calculateReversal', () => {
  it('reverses a full refund as the exact negation, never a recalculation', () => {
    // 10% of 4567 accrued 457 (rounded up from 456.7). A recalculation of the
    // refund would give -457 too here, but the guarantee must not depend on
    // that coincidence — a full refund always negates exactly.
    const r = calculateReversal({
      accrued: gbp(457),
      originalBasis: gbp(4_567),
      refunded: gbp(4_567),
    });
    expect(r.amount).toEqual(gbp(-457));
    expect(r.isFullReversal).toBe(true);
  });

  it('nets a full refund back to exactly zero, across a sweep', () => {
    for (let basis = 1; basis < 500; basis += 3) {
      for (const rateBps of [333, 1000, 1250, 7777]) {
        const { amount: accrued } = calculateCommission({
          basis: gbp(basis),
          rateBps,
          rateBasis: 'order_total',
        });
        const reversal = calculateReversal({
          accrued,
          originalBasis: gbp(basis),
          refunded: gbp(basis),
        });
        expect(accrued.amountMinor + reversal.amount.amountMinor).toBe(0);
      }
    }
  });

  it('prorates a partial refund', () => {
    // Half of a 1000 accrual on a 10000 basis, refunding 5000.
    const r = calculateReversal({
      accrued: gbp(1_000),
      originalBasis: gbp(10_000),
      refunded: gbp(5_000),
    });
    expect(r.amount).toEqual(gbp(-500));
    expect(r.isFullReversal).toBe(false);
  });

  it('rounds a partial refund half away from zero', () => {
    // 1/3 of 100 = 33.33… → 33
    expect(
      calculateReversal({ accrued: gbp(100), originalBasis: gbp(300), refunded: gbp(100) }).amount,
    ).toEqual(gbp(-33));
    // 1/2 of 101 = 50.5 → 51
    expect(
      calculateReversal({ accrued: gbp(101), originalBasis: gbp(200), refunded: gbp(100) }).amount,
    ).toEqual(gbp(-51));
  });

  it('treats a refund beyond the basis as a full reversal, never more', () => {
    // Brand refunds shipping on top of the line total. Commission was never
    // earned on shipping, so the clawback stops at 100% of what was accrued.
    const r = calculateReversal({
      accrued: gbp(500),
      originalBasis: gbp(5_000),
      refunded: gbp(5_500),
    });
    expect(r.amount).toEqual(gbp(-500));
    expect(r.isFullReversal).toBe(true);
  });

  it('reverses nothing when nothing was refunded', () => {
    const r = calculateReversal({ accrued: gbp(500), originalBasis: gbp(5_000), refunded: gbp(0) });
    expect(r.amount).toEqual(gbp(0));
    expect(r.workings).toMatch(/nothing refunded/);
  });

  it('reverses nothing when the original basis was zero', () => {
    const r = calculateReversal({ accrued: gbp(0), originalBasis: gbp(0), refunded: gbp(100) });
    expect(r.amount).toEqual(gbp(0));
  });

  it('refuses to mix currencies', () => {
    expect(() =>
      calculateReversal({ accrued: gbp(500), originalBasis: usd(5_000), refunded: gbp(100) }),
    ).toThrow(CurrencyMismatchError);
  });

  it('two partial refunds summing to the whole reverse the whole', () => {
    const accrued = gbp(1_000);
    const basis = gbp(10_000);

    // Refunds arrive cumulatively, so the second call carries the running total.
    const first = calculateReversal({ accrued, originalBasis: basis, refunded: gbp(3_000) });
    const second = calculateReversal({ accrued, originalBasis: basis, refunded: gbp(10_000) });

    expect(first.amount).toEqual(gbp(-300));
    // The cumulative target is the full reversal; the delta is what remains.
    const delta = outstandingReversal(second, first.amount);
    expect(delta).toEqual(gbp(-700));
    expect(first.amount.amountMinor + delta.amountMinor).toBe(-accrued.amountMinor);
  });
});

/* --------------------------------------------------- replay idempotency */

describe('outstandingReversal', () => {
  it('is zero when the target is already fully reversed', () => {
    const target = calculateReversal({
      accrued: gbp(500),
      originalBasis: gbp(5_000),
      refunded: gbp(5_000),
    });
    expect(outstandingReversal(target, gbp(-500))).toEqual(gbp(0));
  });

  it('returns the remaining delta when partly reversed', () => {
    const target = calculateReversal({
      accrued: gbp(500),
      originalBasis: gbp(5_000),
      refunded: gbp(5_000),
    });
    expect(outstandingReversal(target, gbp(-200))).toEqual(gbp(-300));
  });

  it('refuses to mix currencies', () => {
    const target = calculateReversal({
      accrued: gbp(500),
      originalBasis: gbp(5_000),
      refunded: gbp(5_000),
    });
    expect(() => outstandingReversal(target, usd(-200))).toThrow(CurrencyMismatchError);
  });
});

/* ------------------------------------------------------- currency safety */

describe('currency handling', () => {
  it('sums a single currency', () => {
    expect(sumMoney([gbp(100), gbp(250), gbp(-50)])).toEqual(gbp(300));
  });

  it('refuses to sum across currencies', () => {
    expect(() => sumMoney([gbp(100), usd(100)])).toThrow(CurrencyMismatchError);
  });

  it('names the currencies it refused to combine', () => {
    try {
      sumMoney([gbp(100), usd(100)]);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('GBP');
      expect((err as Error).message).toContain('USD');
      expect((err as Error).message).toMatch(/conversion rate/);
    }
  });

  it('refuses to invent a currency for an empty sum', () => {
    expect(() => sumMoney([])).toThrow(/without knowing which currency/);
    expect(sumMoney([], 'GBP')).toEqual(gbp(0));
  });

  it('groups a mixed set per currency rather than failing', () => {
    const grouped = sumByCurrency([gbp(100), usd(500), gbp(50), usd(-100)]);
    expect(grouped).toEqual([gbp(150), usd(400)]);
  });

  it('formats to the right number of decimals for the currency', () => {
    expect(formatMoney(gbp(123_456), 'en-GB')).toContain('1,234.56');
    // JPY has no minor unit: 100 minor units is ¥100, not ¥1.00.
    expect(formatMoney({ amountMinor: 100, currency: 'JPY' }, 'en-GB')).toContain('100');
    expect(formatMoney({ amountMinor: 100, currency: 'JPY' }, 'en-GB')).not.toContain('1.00');
  });

  it('still renders an ISO-shaped code Intl does not recognise', () => {
    expect(formatMoney({ amountMinor: 12_345, currency: 'ZZZ' })).toContain('123.45');
  });
});
