import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import {
  mapRows,
  normaliseTypedCode,
  parseCsv,
  type ColumnMapping,
  type MappingReport,
  type NormalisedOrder,
  type OrderSourceId,
} from '@anton/shared';
import { IngestBatchModel, OrderModel } from '../db/models/Order.js';
import { ApiError } from '../lib/errors.js';

/**
 * Turning a parsed file into rows in the database.
 *
 * The guarantee this module exists to provide: re-uploading the same export
 * updates existing orders and never duplicates them. Everything below is
 * shaped by that, because a duplicated order double-pays a creator and the
 * brand finds out from their bank statement.
 */

export interface PreviewResult {
  readonly report: MappingReport;
  readonly previewRows: readonly NormalisedOrder[];
  readonly headers: readonly string[];
  readonly raggedRows: readonly { line: number; got: number; expected: number }[];
  /** Orders in the file that this brand already has. */
  readonly existingCount: number;
  readonly fileSha256: string;
  /** A byte-identical file already committed. */
  readonly identicalBatch: { id: string; committedAt: Date | null } | null;
}

const PREVIEW_ROWS = 20;

export function hashFile(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parses and reports, without writing a single order.
 *
 * The operator sees exactly what would happen before it happens: what parsed,
 * what did not and why, what is already here, and which dates and currencies
 * the file covers.
 */
export async function previewCsv(params: {
  brandId: Types.ObjectId;
  bytes: Buffer;
  mapping: ColumnMapping;
}): Promise<PreviewResult> {
  const text = params.bytes.toString('utf8');
  const parsed = parseCsv(text);
  const report = mapRows(parsed.rows, params.mapping);

  const fileSha256 = hashFile(params.bytes);

  const identical = await IngestBatchModel.findOne({
    brandId: params.brandId,
    fileSha256,
    status: 'committed',
  })
    .select('_id committedAt')
    .lean();

  const externalIds = report.orders.map((o) => o.externalOrderId);
  const existingCount = await OrderModel.countDocuments({
    brandId: params.brandId,
    source: 'manual_csv',
    externalOrderId: { $in: externalIds },
  });

  return {
    report,
    previewRows: report.orders.slice(0, PREVIEW_ROWS),
    headers: parsed.headers,
    raggedRows: parsed.raggedRows,
    existingCount,
    fileSha256,
    identicalBatch: identical
      ? { id: identical._id.toString(), committedAt: identical.committedAt ?? null }
      : null,
  };
}

export interface CommitResult {
  readonly batchId: string;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsSkipped: number;
  readonly duplicatesInFile: number;
  /** Orders whose refund state changed, so attribution can reverse them. */
  readonly changedOrderIds: readonly string[];
}

/**
 * Writes a batch.
 *
 * Every order is an upsert keyed on (brand, source, externalOrderId) — the same
 * tuple carrying the unique index. Running the same file twice therefore
 * produces the same rows, and the second run reports 0 inserted rather than
 * silently doubling the brand's revenue.
 */
export async function commitOrders(params: {
  brandId: Types.ObjectId;
  source: OrderSourceId;
  operatorId: Types.ObjectId;
  orders: readonly NormalisedOrder[];
  report: MappingReport;
  filename: string | null;
  fileSha256: string | null;
}): Promise<CommitResult> {
  const now = new Date();

  const batch = await IngestBatchModel.create({
    brandId: params.brandId,
    source: params.source,
    status: 'previewed',
    uploadedByOperatorId: params.operatorId,
    filename: params.filename,
    fileSha256: params.fileSha256,
    rowsParsed: params.report.rowsParsed,
    rowsSkipped: params.report.rowsSkipped,
    duplicatesInFile: params.report.duplicatesInFile.length,
    // Capped: a wholly malformed file should not write a megabyte of reasons.
    skipReasons: params.report.skipped.slice(0, 200),
    currencies: params.report.currencies,
    dateRangeFrom: params.report.dateRangeFrom,
    dateRangeTo: params.report.dateRangeTo,
  });

  let inserted = 0;
  let updated = 0;
  const changedOrderIds: string[] = [];

  for (const order of params.orders) {
    const existing = await OrderModel.findOne({
      brandId: params.brandId,
      source: params.source,
      externalOrderId: order.externalOrderId,
    })
      .select('_id status refundedAmount')
      .lean();

    const doc = {
      brandId: params.brandId,
      externalOrderId: order.externalOrderId,
      source: params.source,
      orderedAt: order.orderedAt,
      total: order.total,
      subtotal: order.subtotal,
      currency: order.total.currency,
      discountCodeUsed: order.discountCodeUsed,
      discountCodeKey: order.discountCodeUsed ? normaliseTypedCode(order.discountCodeUsed) : null,
      attributionRef: order.attributionRef,
      customerType: order.customerType,
      status: order.status,
      refundedAmount: order.refundedAmount,
      refundedAt: order.refundedAt,
      ingestBatchId: batch._id,
      rawRow: order.rawRow,
    };

    if (!existing) {
      await OrderModel.create({ ...doc, ingestHistory: [{ batchId: batch._id, at: now }] });
      inserted += 1;
      changedOrderIds.push(order.externalOrderId);
      continue;
    }

    /**
     * A refund arriving in a later batch is the case that matters.
     *
     * The order already exists as confirmed; this upload says it came back.
     * Flagging it here is what lets the attribution engine generate the
     * reversal, so the change is detected rather than merely overwritten.
     */
    const refundChanged =
      existing.status !== order.status ||
      (existing.refundedAmount?.amountMinor ?? 0) !== (order.refundedAmount?.amountMinor ?? 0);

    await OrderModel.updateOne(
      { _id: existing._id },
      {
        $set: doc,
        $push: { ingestHistory: { batchId: batch._id, at: now } },
      },
    );
    updated += 1;
    if (refundChanged) changedOrderIds.push(order.externalOrderId);
  }

  await IngestBatchModel.updateOne(
    { _id: batch._id },
    {
      $set: {
        status: 'committed',
        committedAt: now,
        rowsInserted: inserted,
        rowsUpdated: updated,
      },
    },
  );

  return {
    batchId: batch._id.toString(),
    rowsInserted: inserted,
    rowsUpdated: updated,
    rowsSkipped: params.report.rowsSkipped,
    duplicatesInFile: params.report.duplicatesInFile.length,
    changedOrderIds,
  };
}

/**
 * Rolls a batch back.
 *
 * Deletes only the orders this batch INSERTED. Orders it merely updated are
 * left as they are: a later batch may have touched them since, and reverting
 * them to a state no upload ever asserted would invent data. The batch's own
 * summary records what it did, so the difference stays visible.
 */
export async function rollbackBatch(params: {
  batchId: Types.ObjectId;
  brandId: Types.ObjectId;
  operatorId: Types.ObjectId;
}): Promise<{ ordersDeleted: number; ordersLeftAlone: number }> {
  const batch = await IngestBatchModel.findOne({
    _id: params.batchId,
    brandId: params.brandId,
  });
  if (!batch) throw ApiError.notFound('batch_not_found', 'No such batch for this brand.');
  if (batch.status !== 'committed') {
    throw ApiError.conflict('not_committed', 'That batch is not in a committed state.');
  }

  // Inserted by this batch = this batch is the FIRST entry in its history.
  const candidates = await OrderModel.find({
    brandId: params.brandId,
    'ingestHistory.batchId': params.batchId,
  })
    .select('_id ingestHistory')
    .lean();

  const insertedByThisBatch = candidates
    .filter((o) => String(o.ingestHistory[0]?.batchId) === String(params.batchId))
    .map((o) => o._id);

  const deleted = await OrderModel.deleteMany({ _id: { $in: insertedByThisBatch } });

  await IngestBatchModel.updateOne(
    { _id: batch._id },
    {
      $set: {
        status: 'rolled_back',
        rolledBackAt: new Date(),
        rolledBackByOperatorId: params.operatorId,
      },
    },
  );

  return {
    ordersDeleted: deleted.deletedCount,
    ordersLeftAlone: candidates.length - insertedByThisBatch.length,
  };
}
