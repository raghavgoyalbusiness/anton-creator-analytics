import { minorUnitExponent } from '../types/common.js';
import type { NormalisedOrder } from '../types/commerce.js';
import type { ColumnMapping } from '../schemas/commerce.js';
import {
  parseCustomerType,
  parseDateString,
  parseMoneyString,
  parseOrderStatus,
} from './csv.js';

/**
 * Turning a mapped CSV row into a NormalisedOrder.
 *
 * Every failure names the row and the reason, because the person fixing it is a
 * brand's ops person looking at a spreadsheet, not an engineer reading a stack
 * trace.
 */

export interface RowResult {
  readonly line: number;
  readonly ok: boolean;
  readonly order: NormalisedOrder | null;
  readonly reason: string | null;
}

export interface MappingReport {
  readonly rowsParsed: number;
  readonly rowsSkipped: number;
  readonly orders: readonly NormalisedOrder[];
  readonly skipped: readonly { line: number; reason: string }[];
  /** externalOrderIds appearing more than once IN THE FILE. */
  readonly duplicatesInFile: readonly { externalOrderId: string; lines: number[] }[];
  readonly dateRangeFrom: Date | null;
  readonly dateRangeTo: Date | null;
  readonly currencies: readonly string[];
}

function cell(row: Readonly<Record<string, string>>, column: string | null): string {
  return column === null ? '' : (row[column] ?? '');
}

export function mapRow(
  row: Readonly<Record<string, string>>,
  mapping: ColumnMapping,
  line: number,
): RowResult {
  const fail = (reason: string): RowResult => ({ line, ok: false, order: null, reason });

  const externalOrderId = cell(row, mapping.externalOrderId).trim();
  if (externalOrderId.length === 0) return fail('no order id');

  const orderedAtRaw = cell(row, mapping.orderedAt);
  const orderedAt = parseDateString(orderedAtRaw);
  if (!orderedAt.ok) return fail(`order date: ${orderedAt.reason}`);

  const currency = (cell(row, mapping.currency).trim() || mapping.fallbackCurrency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return fail(`currency "${currency}" is not a three-letter ISO code`);
  }
  const exponent = minorUnitExponent(currency);

  const totalRaw = cell(row, mapping.total);
  const total = parseMoneyString(totalRaw, exponent);
  if (!total.ok) return fail(`total: ${total.reason}`);
  if (total.amountMinor < 0) return fail(`total is negative ("${totalRaw}")`);

  /**
   * A missing subtotal falls back to the total.
   *
   * Many exports have no subtotal column at all. Falling back is safe in the
   * direction that matters: commission on `order_subtotal` then equals
   * commission on the total, which over-pays the creator slightly rather than
   * under-paying them, and the operator can see the mapping was blank.
   */
  const subtotalRaw = cell(row, mapping.subtotal);
  let subtotalMinor = total.amountMinor;
  if (subtotalRaw.trim().length > 0) {
    const subtotal = parseMoneyString(subtotalRaw, exponent);
    if (!subtotal.ok) return fail(`subtotal: ${subtotal.reason}`);
    if (subtotal.amountMinor < 0) return fail(`subtotal is negative ("${subtotalRaw}")`);
    if (subtotal.amountMinor > total.amountMinor) {
      return fail(`subtotal ${subtotalRaw} is greater than total ${totalRaw}`);
    }
    subtotalMinor = subtotal.amountMinor;
  }

  const statusRaw = cell(row, mapping.status);
  let status: NormalisedOrder['status'] = 'confirmed';
  if (statusRaw.trim().length > 0) {
    const parsed = parseOrderStatus(statusRaw);
    if (parsed === null) return fail(`status "${statusRaw}" was not recognised`);
    status = parsed;
  }

  const refundedRaw = cell(row, mapping.refundedAmount);
  let refundedAmount: NormalisedOrder['refundedAmount'] = null;
  if (refundedRaw.trim().length > 0) {
    const refunded = parseMoneyString(refundedRaw, exponent);
    if (!refunded.ok) return fail(`refunded amount: ${refunded.reason}`);
    if (refunded.amountMinor < 0) return fail(`refunded amount is negative ("${refundedRaw}")`);
    if (refunded.amountMinor > 0) refundedAmount = { amountMinor: refunded.amountMinor, currency };
  }

  /**
   * Reconcile status and refund amount rather than trusting either alone.
   *
   * Exports disagree with themselves constantly: a row marked "refunded" with a
   * zero refund column, or a refund figure on a row still marked paid. The
   * amount is the load-bearing value — it is what a reversal is computed from —
   * so the status is derived from it where they conflict.
   */
  if (refundedAmount !== null && status === 'confirmed') {
    status = refundedAmount.amountMinor >= total.amountMinor ? 'refunded' : 'partially_refunded';
  }
  if ((status === 'refunded' || status === 'partially_refunded') && refundedAmount === null) {
    if (status === 'refunded') {
      // "Refunded" with no figure means the whole order came back.
      refundedAmount = { amountMinor: total.amountMinor, currency };
    } else {
      return fail('marked partially refunded but no refund amount was given');
    }
  }

  const refundedAtRaw = cell(row, mapping.refundedAt);
  let refundedAt: Date | null = null;
  if (refundedAtRaw.trim().length > 0) {
    const parsed = parseDateString(refundedAtRaw);
    if (!parsed.ok) return fail(`refund date: ${parsed.reason}`);
    refundedAt = parsed.date;
  }

  const discountCodeUsed = cell(row, mapping.discountCode).trim() || null;

  return {
    line,
    ok: true,
    reason: null,
    order: {
      externalOrderId,
      orderedAt: orderedAt.date,
      total: { amountMinor: total.amountMinor, currency },
      subtotal: { amountMinor: subtotalMinor, currency },
      discountCodeUsed,
      customerType: parseCustomerType(cell(row, mapping.customerType)),
      status,
      refundedAmount,
      refundedAt,
      // Verbatim. When a figure is challenged, this is what settles it.
      rawRow: { ...row },
    },
  };
}

/**
 * Maps a whole file and reports what it could and could not read.
 *
 * A duplicate id within one file keeps the LAST occurrence: exports commonly
 * append a corrected row rather than editing in place, so the later row is the
 * brand's most recent statement about that order.
 */
export function mapRows(
  rows: readonly Readonly<Record<string, string>>[],
  mapping: ColumnMapping,
  firstLine = 2,
): MappingReport {
  const results = rows.map((row, i) => mapRow(row, mapping, firstLine + i));

  const byId = new Map<string, { order: NormalisedOrder; lines: number[] }>();
  const skipped: { line: number; reason: string }[] = [];

  for (const r of results) {
    if (!r.ok || !r.order) {
      skipped.push({ line: r.line, reason: r.reason ?? 'unknown' });
      continue;
    }
    const existing = byId.get(r.order.externalOrderId);
    if (existing) {
      existing.lines.push(r.line);
      existing.order = r.order;
    } else {
      byId.set(r.order.externalOrderId, { order: r.order, lines: [r.line] });
    }
  }

  const orders = [...byId.values()].map((v) => v.order);
  const duplicates = [...byId.entries()]
    .filter(([, v]) => v.lines.length > 1)
    .map(([externalOrderId, v]) => ({ externalOrderId, lines: v.lines }));

  const dates = orders.map((o) => o.orderedAt.getTime());
  const currencies = [...new Set(orders.map((o) => o.total.currency))].sort();

  return {
    rowsParsed: orders.length,
    rowsSkipped: skipped.length,
    orders,
    skipped,
    duplicatesInFile: duplicates,
    dateRangeFrom: dates.length > 0 ? new Date(Math.min(...dates)) : null,
    dateRangeTo: dates.length > 0 ? new Date(Math.max(...dates)) : null,
    currencies,
  };
}
