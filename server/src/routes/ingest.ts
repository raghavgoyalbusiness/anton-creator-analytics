import { Router, raw } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import {
  columnMappingSchema,
  guessMapping,
  objectIdSchema,
  parseCsv,
  toCsv,
  type ColumnMapping,
} from '@anton/shared';
import {
  ColumnMappingModel,
  IngestBatchModel,
  OrderModel,
} from '../db/models/Order.js';
import { BrandModel } from '../db/models/index.js';
import { getOperator, requireFreshReauth, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseBody } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { DAY_MS, HOUR_MS, enforceRateLimit } from '../lib/rate-limit.js';
import { commitOrders, hashFile, previewCsv, rollbackBatch } from '../ingest/commit.js';
import { runAttribution } from '../attribution/run.js';
import { postCommission } from '../commission/post.js';

export const ingestRouter: Router = Router();
ingestRouter.use(requireOperator);

/**
 * Order ingestion.
 *
 * Everything here handles a brand's commercial data and their customers' order
 * records. Two rules run through it: every query is scoped by a brand id taken
 * from the route, never from a body the client controls, and no route logs a
 * raw row.
 */

/** Uploads are small — an order export is text. 20 MB is generous. */
const MAX_CSV_BYTES = 20 * 1024 * 1024;

/**
 * Content sniffing for CSV.
 *
 * There are no magic bytes for CSV, so the check is structural: it must decode
 * as UTF-8 without replacement characters, must not begin with a known binary
 * signature, and must parse. A spreadsheet saved as .xlsx and renamed .csv is
 * the common mistake, and it is a ZIP.
 */
const BINARY_SIGNATURES: { label: string; bytes: number[] }[] = [
  { label: 'a ZIP archive (an .xlsx workbook?)', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { label: 'an old Excel .xls workbook', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
  { label: 'a PDF', bytes: [0x25, 0x50, 0x44, 0x46] },
  { label: 'a PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { label: 'a JPEG', bytes: [0xff, 0xd8, 0xff] },
  { label: 'a gzip archive', bytes: [0x1f, 0x8b] },
];

export function sniffNotCsv(bytes: Buffer): string | null {
  for (const sig of BINARY_SIGNATURES) {
    if (sig.bytes.every((b, i) => bytes[i] === b)) return sig.label;
  }
  // A NUL byte in the first kilobyte means this is not text.
  if (bytes.subarray(0, 1024).includes(0)) return 'a binary file';
  return null;
}

async function requireBrand(brandIdRaw: unknown): Promise<Types.ObjectId> {
  if (typeof brandIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(brandIdRaw)) {
    throw ApiError.badRequest('bad_brand_id', 'Not a valid brand id.');
  }
  const brand = await BrandModel.findById(brandIdRaw).select('_id').lean();
  if (!brand) throw ApiError.notFound('brand_not_found', 'No such brand.');
  return brand._id;
}

/* ------------------------------------------------------------- mappings */

ingestRouter.get(
  '/brands/:brandId/column-mapping',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const saved = await ColumnMappingModel.findOne({ brandId, source: 'manual_csv' }).lean();
    res.json({ mapping: saved?.mapping ?? null, updatedAt: saved?.updatedAt ?? null });
  }),
);

ingestRouter.put(
  '/brands/:brandId/column-mapping',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const mapping = parseBody(columnMappingSchema, req);
    const { operator } = getOperator(req);

    await ColumnMappingModel.findOneAndUpdate(
      { brandId, source: 'manual_csv' },
      { $set: { mapping, updatedByOperatorId: operator._id } },
      { upsert: true },
    );

    /**
     * Worth a log line. A mapping decides which column becomes the commission
     * basis, so changing it silently changes what every future upload pays.
     */
    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.columnMappingSaved,
      subjectKind: 'Brand',
      subjectId: brandId,
      detail: { brandId: brandId.toString(), fields: mapping },
      ipHash: hashIp(clientIp(req)),
    });

    res.json({ ok: true });
  }),
);

/** Suggests a mapping from a header row, for the operator to correct. */
ingestRouter.post(
  '/brands/:brandId/column-mapping/guess',
  asyncRoute(async (req, res) => {
    await requireBrand(req.params.brandId);
    const body = parseBody(z.object({ headerRow: z.string().min(1).max(8_000) }), req);
    const parsed = parseCsv(`${body.headerRow}\n`);
    res.json({ headers: parsed.headers, guess: guessMapping(parsed.headers) });
  }),
);

/* -------------------------------------------------------------- preview */

/**
 * Parses and reports without writing anything.
 *
 * The raw body is taken as a Buffer so the file is never coerced through JSON,
 * and the size cap is enforced by the body parser before we hold it in memory.
 */
ingestRouter.post(
  '/brands/:brandId/orders/preview',
  raw({ type: ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'], limit: MAX_CSV_BYTES }),
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    await enforceRateLimit(
      { bucket: 'ingest_preview', subject: operator._id.toString(), limit: 60, windowMs: HOUR_MS },
      'Too many uploads in the last hour.',
    );

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw ApiError.badRequest('empty_upload', 'No file was received.');
    }

    const notCsv = sniffNotCsv(bytes);
    if (notCsv) {
      throw ApiError.badRequest(
        'not_a_csv',
        `That looks like ${notCsv}, not a CSV. Export as CSV and upload again.`,
      );
    }

    const text = bytes.toString('utf8');
    if (text.includes('�')) {
      throw ApiError.badRequest(
        'not_utf8',
        'The file is not valid UTF-8. Re-export it with UTF-8 encoding.',
      );
    }

    const saved = await ColumnMappingModel.findOne({ brandId, source: 'manual_csv' }).lean();
    const headerOnly = parseCsv(`${text.split('\n')[0] ?? ''}\n`);

    // No saved mapping yet: hand back a guess for the operator to confirm,
    // rather than parsing against something they never agreed to.
    if (!saved) {
      res.json({
        needsMapping: true,
        headers: headerOnly.headers,
        guess: guessMapping(headerOnly.headers),
      });
      return;
    }

    const result = await previewCsv({
      brandId,
      bytes,
      mapping: saved.mapping as ColumnMapping,
    });

    res.json({
      needsMapping: false,
      fileSha256: result.fileSha256,
      headers: result.headers,
      identicalBatch: result.identicalBatch,
      validation: {
        rowsParsed: result.report.rowsParsed,
        rowsSkipped: result.report.rowsSkipped,
        skipped: result.report.skipped.slice(0, 50),
        raggedRows: result.raggedRows.slice(0, 50),
        duplicatesInFile: result.report.duplicatesInFile,
        alreadyPresent: result.existingCount,
        wouldInsert: result.report.rowsParsed - result.existingCount,
        wouldUpdate: result.existingCount,
        dateRangeFrom: result.report.dateRangeFrom,
        dateRangeTo: result.report.dateRangeTo,
        currencies: result.report.currencies,
      },
      /**
       * The preview omits rawRow. It contains customer data and this response
       * ends up in a browser devtools panel and, from there, in screenshots.
       */
      preview: result.previewRows.map((o) => ({
        externalOrderId: o.externalOrderId,
        orderedAt: o.orderedAt,
        total: o.total,
        subtotal: o.subtotal,
        discountCodeUsed: o.discountCodeUsed,
        status: o.status,
        refundedAmount: o.refundedAmount,
        customerType: o.customerType,
      })),
    });
  }),
);

/* --------------------------------------------------------------- commit */

ingestRouter.post(
  '/brands/:brandId/orders/commit',
  raw({ type: ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/octet-stream'], limit: MAX_CSV_BYTES }),
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    await enforceRateLimit(
      { bucket: 'ingest_commit', subject: operator._id.toString(), limit: 30, windowMs: HOUR_MS },
      'Too many commits in the last hour.',
    );
    await enforceRateLimit(
      { bucket: 'ingest_commit_global', subject: 'global', limit: 500, windowMs: DAY_MS },
      'Anton is at its daily ingest limit.',
    );

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw ApiError.badRequest('empty_upload', 'No file was received.');
    }
    const notCsv = sniffNotCsv(bytes);
    if (notCsv) throw ApiError.badRequest('not_a_csv', `That looks like ${notCsv}, not a CSV.`);

    const saved = await ColumnMappingModel.findOne({ brandId, source: 'manual_csv' }).lean();
    if (!saved) {
      throw ApiError.badRequest(
        'no_mapping',
        'Save a column mapping for this brand before committing.',
      );
    }

    const preview = await previewCsv({ brandId, bytes, mapping: saved.mapping as ColumnMapping });

    if (preview.report.orders.length === 0) {
      throw ApiError.badRequest(
        'nothing_to_commit',
        `No rows parsed. ${preview.report.rowsSkipped} were skipped — check the mapping.`,
      );
    }

    const result = await commitOrders({
      brandId,
      source: 'manual_csv',
      operatorId: operator._id,
      orders: preview.report.orders,
      report: preview.report,
      filename: typeof req.query.filename === 'string' ? req.query.filename.slice(0, 260) : null,
      fileSha256: hashFile(bytes),
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.ordersIngested,
      subjectKind: 'IngestBatch',
      subjectId: new Types.ObjectId(result.batchId),
      // Counts only. Never the rows.
      detail: {
        brandId: brandId.toString(),
        inserted: result.rowsInserted,
        updated: result.rowsUpdated,
        skipped: result.rowsSkipped,
        changed: result.changedOrderIds.length,
      },
      ipHash: hashIp(clientIp(req)),
    });

    /**
     * Attribution runs over the orders this batch touched, not over everything.
     *
     * Scoped to the changed rows because that is the set whose answer can have
     * moved — and because an operator uploading a small correction should not
     * pay the cost of re-deciding a year of orders. The full re-run is a
     * separate, deliberate action.
     */
    const attribution = await runAttribution({
      brandId,
      externalOrderIds: result.changedOrderIds,
    });

    /**
     * The ledger is posted in the same request as the attribution that feeds
     * it. Leaving a gap between them means a window where the brand can see an
     * attributed order that owes nobody anything, which reads as a bug to
     * everyone who sees it.
     */
    const commission = await postCommission({ brandId, createdBy: operator.email });

    res.status(201).json({ ...result, attribution, commission });
  }),
);

/* --------------------------------------------------------------- batches */

ingestRouter.get(
  '/brands/:brandId/ingest-batches',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const batches = await IngestBatchModel.find({ brandId }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({
      batches: batches.map((b) => ({
        id: b._id.toString(),
        source: b.source,
        status: b.status,
        filename: b.filename,
        rowsParsed: b.rowsParsed,
        rowsInserted: b.rowsInserted,
        rowsUpdated: b.rowsUpdated,
        rowsSkipped: b.rowsSkipped,
        duplicatesInFile: b.duplicatesInFile,
        skipReasons: b.skipReasons,
        currencies: b.currencies,
        dateRangeFrom: b.dateRangeFrom,
        dateRangeTo: b.dateRangeTo,
        createdAt: b.createdAt,
        committedAt: b.committedAt,
        rolledBackAt: b.rolledBackAt,
      })),
    });
  }),
);

/**
 * Rolling a batch back deletes orders, so it sits behind a fresh password
 * check like every other bulk destructive action.
 */
ingestRouter.post(
  '/brands/:brandId/ingest-batches/:batchId/rollback',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const batchIdRaw = req.params.batchId;
    if (typeof batchIdRaw !== 'string' || !/^[a-f0-9]{24}$/i.test(batchIdRaw)) {
      throw ApiError.badRequest('bad_id', 'Not a valid batch id.');
    }
    const { operator } = getOperator(req);

    const result = await rollbackBatch({
      batchId: new Types.ObjectId(batchIdRaw),
      brandId,
      operatorId: operator._id,
    });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.ordersBatchRolledBack,
      subjectKind: 'IngestBatch',
      subjectId: new Types.ObjectId(batchIdRaw),
      detail: { brandId: brandId.toString(), ...result },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(result);
  }),
);

/* ---------------------------------------------------------------- orders */

const orderQuerySchema = z.object({
  campaignId: objectIdSchema.optional(),
  status: z.enum(['confirmed', 'refunded', 'partially_refunded', 'cancelled', 'all']).default('all'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

ingestRouter.get(
  '/brands/:brandId/orders',
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const query = orderQuerySchema.parse(req.query);

    // Brand scope comes from the route, never from the query.
    const filter: Record<string, unknown> = { brandId };
    if (query.status !== 'all') filter.status = query.status;

    const orders = await OrderModel.find(filter).sort({ orderedAt: -1 }).limit(query.limit).lean();
    res.json({ orders: orders.map(serialiseOrder) });
  }),
);

/**
 * Order export.
 *
 * Behind a fresh password check, and every cell neutralised against formula
 * injection on the way out — a customer-supplied field in the brand's own
 * export becomes an executable payload the moment it lands in a spreadsheet.
 */
ingestRouter.get(
  '/brands/:brandId/orders/export',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const brandId = await requireBrand(req.params.brandId);
    const { operator } = getOperator(req);

    const orders = await OrderModel.find({ brandId }).sort({ orderedAt: -1 }).limit(20_000).lean();

    const rows = orders.map((o) => ({
      externalOrderId: o.externalOrderId,
      orderedAt: o.orderedAt.toISOString(),
      currency: o.currency,
      totalMinor: o.total.amountMinor,
      subtotalMinor: o.subtotal.amountMinor,
      discountCodeUsed: o.discountCodeUsed ?? '',
      status: o.status,
      refundedMinor: o.refundedAmount?.amountMinor ?? '',
      customerType: o.customerType,
      source: o.source,
    }));

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.ordersExported,
      detail: { brandId: brandId.toString(), rows: rows.length },
      ipHash: hashIp(clientIp(req)),
    });

    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="anton-orders.csv"');
    res.send(toCsv(rows, Object.keys(rows[0] ?? { externalOrderId: '' })));
  }),
);

function serialiseOrder(o: {
  _id: Types.ObjectId;
  externalOrderId: string;
  source: string;
  orderedAt: Date;
  total: { amountMinor: number; currency: string };
  subtotal: { amountMinor: number; currency: string };
  discountCodeUsed?: string | null | undefined;
  status: string;
  refundedAmount?: { amountMinor: number; currency: string } | null | undefined;
  refundedAt?: Date | null | undefined;
  customerType: string;
  ingestBatchId: Types.ObjectId;
}): Record<string, unknown> {
  return {
    id: o._id.toString(),
    externalOrderId: o.externalOrderId,
    source: o.source,
    orderedAt: o.orderedAt,
    total: o.total,
    subtotal: o.subtotal,
    discountCodeUsed: o.discountCodeUsed ?? null,
    status: o.status,
    refundedAmount: o.refundedAmount ?? null,
    refundedAt: o.refundedAt ?? null,
    customerType: o.customerType,
    ingestBatchId: o.ingestBatchId.toString(),
    // rawRow is select:false and deliberately not serialised anywhere.
  };
}
