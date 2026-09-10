import { minorUnitsPerMajor, type CurrencyCode, type Money } from '../types/common.js';

/**
 * Money arithmetic.
 *
 * Two rules run through everything here:
 *
 *   1. Amounts are integer minor units. No float ever holds a monetary value,
 *      not even transiently.
 *   2. Currencies never mix silently. Adding GBP to USD is a thrown error, not
 *      a coerced number — a report that quietly sums across currencies is worse
 *      than one that refuses to render.
 */

export class CurrencyMismatchError extends Error {
  constructor(readonly currencies: readonly string[]) {
    super(
      `Refusing to combine amounts in different currencies: ${currencies.join(', ')}. ` +
        'Report per currency, or supply an explicit recorded conversion rate.',
    );
    this.name = 'CurrencyMismatchError';
  }
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Number.isInteger(amountMinor)) {
    throw new RangeError(`money must be whole minor units; got ${amountMinor}`);
  }
  return { amountMinor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return { amountMinor: 0, currency };
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0;
}

export function negate(m: Money): Money {
  return { amountMinor: -m.amountMinor, currency: m.currency };
}

/** Throws unless every amount shares one currency. */
export function assertSameCurrency(amounts: readonly Money[]): CurrencyCode | null {
  if (amounts.length === 0) return null;
  const currencies = [...new Set(amounts.map((a) => a.currency))];
  if (currencies.length > 1) throw new CurrencyMismatchError(currencies);
  return currencies[0] ?? null;
}

/**
 * Sums a list. Empty list needs a currency to return zero in, because a
 * currency-less zero is not a value this system is willing to produce.
 */
export function sumMoney(amounts: readonly Money[], emptyCurrency?: CurrencyCode): Money {
  if (amounts.length === 0) {
    if (emptyCurrency === undefined) {
      throw new Error('cannot sum an empty list without knowing which currency the zero is in');
    }
    return zero(emptyCurrency);
  }
  const currency = assertSameCurrency(amounts);
  if (currency === null) throw new Error('unreachable: non-empty list with no currency');
  return {
    amountMinor: amounts.reduce((acc, a) => acc + a.amountMinor, 0),
    currency,
  };
}

/**
 * Groups by currency so a multi-currency set can still be reported — as
 * several figures side by side, never as one.
 */
export function sumByCurrency(amounts: readonly Money[]): Money[] {
  const buckets = new Map<CurrencyCode, number>();
  for (const a of amounts) {
    buckets.set(a.currency, (buckets.get(a.currency) ?? 0) + a.amountMinor);
  }
  return [...buckets.entries()]
    .map(([currency, amountMinor]) => ({ amountMinor, currency }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * Round half away from zero.
 *
 * Chosen over Math.round, which rounds -0.5 to -0 and so breaks the symmetry a
 * ledger depends on: a reversal of an accrual must be the exact negative of it,
 * and half-toward-positive-infinity silently makes the pair fail to cancel.
 */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** For display only. Never feed the result back into a calculation. */
export function formatMoney(m: Money, locale?: string): string {
  const exponent = Math.log10(minorUnitsPerMajor(m.currency));
  const major = m.amountMinor / minorUnitsPerMajor(m.currency);
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major);
  } catch {
    // An ISO-shaped code Intl does not know still has to render.
    return `${m.currency} ${major.toFixed(exponent)}`;
  }
}
