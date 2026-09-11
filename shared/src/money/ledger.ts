import type { Money } from '../types/common.js';
import { CurrencyMismatchError, sumByCurrency, zero } from './currency.js';

/**
 * The commission ledger.
 *
 * Append-only. Nothing here updates or deletes an entry; a correction is a new
 * entry of type `reversal` or `adjustment`. A balance is therefore always a
 * derived figure — summed on read, never stored on a row that could drift out
 * of agreement with the entries that produced it.
 */

export type CommissionEntryType = 'accrual' | 'reversal' | 'adjustment';
export const COMMISSION_ENTRY_TYPES = [
  'accrual',
  'reversal',
  'adjustment',
] as const satisfies readonly CommissionEntryType[];

/** The shape the balance functions need. The stored document carries more. */
export interface LedgerEntry {
  /**
   * Optional, and only so a caller can correlate a running balance back to the
   * row it belongs to. These functions re-sort, so matching by position is a
   * bug waiting for the first two entries written in the same millisecond.
   */
  readonly id?: string;
  readonly type: CommissionEntryType;
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface LedgerBalance {
  /** Null when the entries span currencies — see `byCurrency`. */
  readonly total: Money | null;
  /** Always populated. One figure per currency present. */
  readonly byCurrency: readonly Money[];
  readonly accrued: readonly Money[];
  readonly reversed: readonly Money[];
  readonly adjusted: readonly Money[];
  readonly entryCount: number;
  /** Populated when `total` is null, saying why. */
  readonly unavailableReason: string | null;
}

/**
 * Sums a ledger.
 *
 * A multi-currency ledger does not produce a total. It produces one figure per
 * currency and an explicit reason the single number is absent, because the
 * alternative — picking a rate and summing anyway — invents a number nobody
 * agreed to.
 */
export function getBalance(entries: readonly LedgerEntry[], emptyCurrency?: string): LedgerBalance {
  if (entries.length === 0) {
    return {
      total: emptyCurrency ? zero(emptyCurrency) : null,
      byCurrency: [],
      accrued: [],
      reversed: [],
      adjusted: [],
      entryCount: 0,
      unavailableReason: emptyCurrency ? null : 'no entries and no currency given',
    };
  }

  const amountsOfType = (type: CommissionEntryType): Money[] =>
    sumByCurrency(entries.filter((e) => e.type === type).map((e) => e.amount));

  const byCurrency = sumByCurrency(entries.map((e) => e.amount));
  const currencies = [...new Set(entries.map((e) => e.amount.currency))];

  return {
    total: byCurrency.length === 1 ? (byCurrency[0] ?? null) : null,
    byCurrency,
    accrued: amountsOfType('accrual'),
    reversed: amountsOfType('reversal'),
    adjusted: amountsOfType('adjustment'),
    entryCount: entries.length,
    unavailableReason:
      byCurrency.length > 1
        ? `entries span ${currencies.length} currencies (${currencies.join(', ')}); reported separately rather than summed`
        : null,
  };
}

/**
 * A running balance, oldest first.
 *
 * Ties on createdAt are broken by the entry's position in the input, so a
 * reversal written in the same millisecond as its accrual still reads after
 * it — which is what a statement has to show.
 */
export function runningBalance(
  entries: readonly LedgerEntry[],
): { entry: LedgerEntry; balanceAfter: Money }[] {
  const ordered = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.createdAt.getTime() - b.entry.createdAt.getTime() || a.index - b.index)
    .map(({ entry }) => entry);

  const currencies = [...new Set(ordered.map((e) => e.amount.currency))];
  if (currencies.length > 1) throw new CurrencyMismatchError(currencies);

  const currency = currencies[0];
  if (currency === undefined) return [];

  let running = 0;
  return ordered.map((entry) => {
    running += entry.amount.amountMinor;
    return { entry, balanceAfter: { amountMinor: running, currency } };
  });
}

/**
 * Sanity checks a ledger can be asked to prove about itself.
 *
 * Not validation of input — these are invariants that should hold by
 * construction, surfaced so a drift shows up in an operator's face rather than
 * in a creator's statement.
 */
export function auditLedger(entries: readonly LedgerEntry[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];

  for (const e of entries) {
    if (!Number.isInteger(e.amount.amountMinor)) {
      problems.push(`entry has a fractional amount: ${e.amount.amountMinor}`);
    }
    if (e.type === 'accrual' && e.amount.amountMinor < 0) {
      problems.push(`accrual is negative (${e.amount.amountMinor}); should be a reversal`);
    }
    if (e.type === 'reversal' && e.amount.amountMinor > 0) {
      problems.push(`reversal is positive (${e.amount.amountMinor}); should be an accrual`);
    }
  }

  return { ok: problems.length === 0, problems };
}
