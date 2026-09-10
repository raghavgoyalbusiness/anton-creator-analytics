import type { Money } from '../types/common.js';
import { CurrencyMismatchError, roundHalfAwayFromZero, zero } from './currency.js';

/**
 * The commission engine.
 *
 * Pure. No database, no clock, no I/O. Every number a creator is owed comes
 * out of these functions, so they are the one place in the system that must be
 * exhaustively tested rather than merely exercised.
 */

/**
 * Rates are basis points — integers, where 10000 bps = 100%.
 *
 * The same discipline as money: no float holds a financial parameter. A rate
 * of "12.5%" stored as 0.125 is a value that cannot be represented exactly in
 * binary floating point, and it multiplies straight into an amount someone is
 * paid. 1250 bps is exact.
 */
export type BasisPoints = number;

export const BPS_PER_UNIT = 10_000;

export type RateBasis = 'order_subtotal' | 'order_total';
export const RATE_BASES = ['order_subtotal', 'order_total'] as const satisfies readonly RateBasis[];

export function bpsFromPercent(percent: number): BasisPoints {
  const exact = percent * 100;
  const rounded = roundHalfAwayFromZero(exact);
  /**
   * Compare before rounding, not after — rounding always yields an integer, so
   * an isInteger check on the result can never fail and would wave through the
   * silent truncation it was meant to catch.
   *
   * The epsilon absorbs float multiply noise (0.01 * 100 is 1.0000000000000002)
   * while still rejecting a rate genuinely finer than a basis point.
   */
  if (Math.abs(exact - rounded) > 1e-9) {
    throw new RangeError(
      `rate ${percent}% is finer than a basis point; the smallest expressible rate is 0.01%`,
    );
  }
  return rounded;
}

export function percentFromBps(bps: BasisPoints): number {
  return bps / 100;
}

export function isValidRate(bps: number): boolean {
  return Number.isInteger(bps) && bps >= 0 && bps <= BPS_PER_UNIT;
}

export interface CommissionInput {
  /** The order figure the rate applies to, already selected by rateBasis. */
  readonly basis: Money;
  readonly rateBps: BasisPoints;
  readonly rateBasis: RateBasis;
}

export interface CommissionResult {
  readonly amount: Money;
  /** Rendered next to the figure so the arithmetic is never a black box. */
  readonly workings: string;
}

/**
 * Commission on one order.
 *
 * Rounds once, at the end, half away from zero. There are no intermediate
 * roundings to accumulate: the whole calculation is a single multiply and
 * divide on integers, and the only fractional value that ever exists is the
 * one immediately handed to the rounder.
 */
export function calculateCommission(input: CommissionInput): CommissionResult {
  if (!isValidRate(input.rateBps)) {
    throw new RangeError(
      `rate must be a whole number of basis points between 0 and ${BPS_PER_UNIT}; got ${input.rateBps}`,
    );
  }
  if (!Number.isInteger(input.basis.amountMinor)) {
    throw new RangeError(`basis must be whole minor units; got ${input.basis.amountMinor}`);
  }

  const exact = (input.basis.amountMinor * input.rateBps) / BPS_PER_UNIT;
  const amountMinor = roundHalfAwayFromZero(exact);

  return {
    amount: { amountMinor, currency: input.basis.currency },
    workings:
      `${percentFromBps(input.rateBps)}% of ${input.basis.amountMinor} ` +
      `(${input.rateBasis.replace('_', ' ')}) = ${exact} → ${amountMinor}`,
  };
}

/** Picks the figure the rate applies to. */
export function selectBasis(
  order: { subtotal: Money; total: Money },
  rateBasis: RateBasis,
): Money {
  return rateBasis === 'order_subtotal' ? order.subtotal : order.total;
}

/* --------------------------------------------------------------- reversals */

export interface ReversalInput {
  /** What was originally accrued for this order. Positive. */
  readonly accrued: Money;
  /** The basis the accrual was calculated on. */
  readonly originalBasis: Money;
  /** How much of that basis has been refunded. */
  readonly refunded: Money;
}

export interface ReversalResult {
  /** Negative, or zero when nothing is owed back. */
  readonly amount: Money;
  readonly isFullReversal: boolean;
  readonly workings: string;
}

/**
 * The commission to claw back when an order is refunded.
 *
 * A full refund reverses the accrual EXACTLY — the negation of the original
 * figure, not a recalculation. Recalculating would let rounding drift leave a
 * penny stranded on a fully refunded order, and a ledger that cannot return to
 * zero is one nobody trusts.
 *
 * A partial refund is prorated against the original accrual rather than
 * recomputed from the rate, for the same reason: the parts must sum back to
 * the whole.
 */
export function calculateReversal(input: ReversalInput): ReversalResult {
  const currencies = new Set([
    input.accrued.currency,
    input.originalBasis.currency,
    input.refunded.currency,
  ]);
  if (currencies.size > 1) throw new CurrencyMismatchError([...currencies]);

  const currency = input.accrued.currency;

  if (input.refunded.amountMinor <= 0) {
    return {
      amount: zero(currency),
      isFullReversal: false,
      workings: 'nothing refunded, nothing reversed',
    };
  }

  if (input.originalBasis.amountMinor <= 0) {
    return {
      amount: zero(currency),
      isFullReversal: false,
      workings: 'original basis was zero or negative; no commission to reverse',
    };
  }

  // At or beyond the original basis is a full refund. "Beyond" happens when a
  // brand refunds shipping on top of the line total; it is still a full refund
  // of what commission was earned on, never more than 100% of it.
  if (input.refunded.amountMinor >= input.originalBasis.amountMinor) {
    return {
      amount: { amountMinor: -input.accrued.amountMinor, currency },
      isFullReversal: true,
      workings: `full refund of ${input.refunded.amountMinor}/${input.originalBasis.amountMinor}: exact negation of ${input.accrued.amountMinor}`,
    };
  }

  const exact =
    (input.accrued.amountMinor * input.refunded.amountMinor) / input.originalBasis.amountMinor;
  const amountMinor = -roundHalfAwayFromZero(exact);

  return {
    amount: { amountMinor, currency },
    isFullReversal: false,
    workings:
      `${input.refunded.amountMinor}/${input.originalBasis.amountMinor} of ${input.accrued.amountMinor} ` +
      `= ${exact} → ${amountMinor}`,
  };
}

/**
 * The reversal still outstanding, given what has already been reversed.
 *
 * Refunds arrive by re-ingest, and a batch may repeat a refund already
 * processed. This returns the delta so replaying a batch is a no-op rather
 * than a second clawback.
 */
export function outstandingReversal(
  target: ReversalResult,
  alreadyReversed: Money,
): Money {
  if (target.amount.currency !== alreadyReversed.currency) {
    throw new CurrencyMismatchError([target.amount.currency, alreadyReversed.currency]);
  }
  return {
    amountMinor: target.amount.amountMinor - alreadyReversed.amountMinor,
    currency: target.amount.currency,
  };
}
