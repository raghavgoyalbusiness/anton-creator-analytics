import { z } from 'zod';
import {
  ATTRIBUTION_METHODS,
  CUSTOMER_TYPES,
  ORDER_SOURCE_IDS,
  ORDER_STATUSES,
  TRACKING_ASSET_STATUSES,
  TRACKING_ASSET_TYPES,
} from '../types/commerce.js';
import { COMMISSION_ENTRY_TYPES } from '../money/ledger.js';
import { BPS_PER_UNIT, RATE_BASES } from '../money/commission.js';
import { currencyCodeSchema, httpUrlSchema, objectIdSchema } from './common.js';

/* ------------------------------------------------------------------ money */

/**
 * Money that may be negative.
 *
 * The existing moneySchema floors at zero, which is right for a rate or a
 * budget and wrong for a ledger entry: a reversal is a negative amount and
 * must be storable as one rather than as a positive with a type flag.
 */
export const signedMoneySchema = z.object({
  amountMinor: z
    .number()
    .int('money must be whole minor units (pence/cents), never a float')
    .refine((v) => Number.isSafeInteger(v), 'amount exceeds safe integer range'),
  currency: currencyCodeSchema,
});

export const positiveMoneySchema = signedMoneySchema.extend({
  amountMinor: z.number().int().nonnegative(),
});

export const rateBpsSchema = z
  .number()
  .int('rates are whole basis points; 12.5% is 1250, not 0.125')
  .min(0)
  .max(BPS_PER_UNIT, `rate cannot exceed 100% (${BPS_PER_UNIT} bps)`);

export const rateBasisSchema = z.enum(RATE_BASES);

/* -------------------------------------------------------- tracking assets */

export const trackingAssetTypeSchema = z.enum(TRACKING_ASSET_TYPES);
export const trackingAssetStatusSchema = z.enum(TRACKING_ASSET_STATUSES);

export const issueTrackingAssetSchema = z
  .object({
    campaignCreatorId: objectIdSchema,
    type: trackingAssetTypeSchema,
    /** Prefix the creator will recognise, e.g. their first name. */
    codeStub: z
      .string()
      .min(2)
      .max(12)
      .regex(/^[A-Za-z]+$/, 'the stub is letters only, so it survives being read aloud')
      .optional(),
    destinationUrl: httpUrlSchema.optional(),
    commissionRateBps: rateBpsSchema,
    commissionRateBasis: rateBasisSchema,
    activeFrom: z.coerce.date().optional(),
    activeUntil: z.coerce.date().nullable().default(null),
  })
  .refine((v) => v.type !== 'tracked_link' || v.destinationUrl !== undefined, {
    message: 'a tracked link needs a destination URL',
    path: ['destinationUrl'],
  });

/* ------------------------------------------------------------------ orders */

export const orderStatusSchema = z.enum(ORDER_STATUSES);
export const customerTypeSchema = z.enum(CUSTOMER_TYPES);
export const orderSourceIdSchema = z.enum(ORDER_SOURCE_IDS);

/**
 * One normalised order, as an adapter hands it over.
 *
 * Cross-field rules are enforced here rather than at the database, so a bad
 * CSV row is rejected with a reason the uploading brand can act on instead of
 * a Mongoose validation error nobody can read.
 */
export const normalisedOrderSchema = z
  .object({
    externalOrderId: z.string().min(1).max(120),
    orderedAt: z.coerce.date(),
    total: positiveMoneySchema,
    subtotal: positiveMoneySchema,
    discountCodeUsed: z.string().max(64).nullable().default(null),
    customerType: customerTypeSchema.default('unknown'),
    status: orderStatusSchema.default('confirmed'),
    refundedAmount: positiveMoneySchema.nullable().default(null),
    refundedAt: z.coerce.date().nullable().default(null),
    rawRow: z.record(z.string(), z.string()),
  })
  .refine((o) => o.total.currency === o.subtotal.currency, {
    message: 'total and subtotal must be in the same currency',
    path: ['subtotal', 'currency'],
  })
  .refine((o) => o.refundedAmount === null || o.refundedAmount.currency === o.total.currency, {
    message: 'refund must be in the order currency',
    path: ['refundedAmount', 'currency'],
  })
  .refine((o) => o.subtotal.amountMinor <= o.total.amountMinor, {
    message: 'subtotal cannot exceed total',
    path: ['subtotal'],
  })
  .refine(
    (o) =>
      o.status !== 'refunded' && o.status !== 'partially_refunded'
        ? true
        : o.refundedAmount !== null,
    { message: 'a refunded order must say how much was refunded', path: ['refundedAmount'] },
  );

/* ---------------------------------------------------------- CSV ingestion */

/** Maps a brand's own column headers onto our fields. Saved per brand. */
export const columnMappingSchema = z.object({
  externalOrderId: z.string().min(1),
  orderedAt: z.string().min(1),
  total: z.string().min(1),
  subtotal: z.string().nullable().default(null),
  currency: z.string().nullable().default(null),
  discountCode: z.string().nullable().default(null),
  customerType: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  refundedAmount: z.string().nullable().default(null),
  refundedAt: z.string().nullable().default(null),
  /**
   * The column recording how the session arrived — Shopify's "Landing Site",
   * a referrer, or a UTM field. Without it, a manual CSV can only ever be
   * attributed by discount code.
   */
  attributionRef: z.string().nullable().default(null),
  /** Used when the file has no currency column. */
  fallbackCurrency: currencyCodeSchema,
});

export type ColumnMapping = z.infer<typeof columnMappingSchema>;

/* ------------------------------------------------------------ attribution */

export const attributionMethodSchema = z.enum(ATTRIBUTION_METHODS);

export const manualAttributionSchema = z.object({
  orderId: objectIdSchema,
  campaignCreatorId: objectIdSchema,
  reason: z.string().min(1, 'say why this was assigned by hand').max(500),
});

/* ---------------------------------------------------------------- ledger */

export const commissionEntryTypeSchema = z.enum(COMMISSION_ENTRY_TYPES);

export const adjustmentSchema = z.object({
  creatorId: objectIdSchema,
  campaignId: objectIdSchema,
  amount: signedMoneySchema,
  reason: z.string().min(1, 'an adjustment must carry a reason').max(500),
});

export const paymentRecordSchema = z.object({
  creatorId: objectIdSchema,
  campaignId: objectIdSchema,
  amount: positiveMoneySchema,
  paidAt: z.coerce.date(),
  method: z.string().max(60).nullable().default(null),
  reference: z.string().max(120).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});

/* ---------------------------------------------------- formula injection */

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * A brand's order export can contain a customer-supplied field. If that field
 * begins with one of these and we write it back out to CSV, opening the export
 * executes it — which is how a note field becomes a data-exfiltration payload
 * in someone's finance team's Excel.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

/**
 * Neutralises a value for CSV export.
 *
 * Prefixes with an apostrophe, which Excel and Sheets both read as "this is
 * text". Applied on the way OUT, not on the way in: the stored value stays
 * exactly what the brand uploaded, so the raw row remains a faithful record.
 */
export function neutraliseCsvCell(value: string): string {
  if (value.length === 0) return value;
  const first = value[0] ?? '';
  return FORMULA_TRIGGERS.includes(first) ? `'${value}` : value;
}

export function isFormulaInjectionRisk(value: string): boolean {
  return value.length > 0 && FORMULA_TRIGGERS.includes(value[0] ?? '');
}

/** RFC 4180 quoting, applied after neutralisation. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const neutralised = neutraliseCsvCell(String(value));
  return /[",\n\r]/.test(neutralised) ? `"${neutralised.replace(/"/g, '""')}"` : neutralised;
}

export function toCsv(
  rows: readonly Readonly<Record<string, unknown>>[],
  columns: readonly string[],
): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}
