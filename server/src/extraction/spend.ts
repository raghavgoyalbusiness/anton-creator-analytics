import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import type { Types } from 'mongoose';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from '../lib/audit.js';

/**
 * Extraction cost control.
 *
 * A per-call ledger row rather than a running total: a counter tells you that
 * you spent too much, a ledger tells you which creator, which post, and which
 * day, which is what you need at 2am when the ceiling trips.
 */
const extractionCostSchema = new Schema(
  {
    at: { type: Date, required: true, index: true },
    /** UTC date key, so a day boundary is unambiguous across deploys. */
    dayKey: { type: String, required: true, index: true },
    creatorId: { type: Schema.Types.ObjectId, ref: 'Creator', required: true, index: true },
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    attempt: { type: Number, required: true, min: 1 },
    model: { type: String, required: true },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    estimatedCostMinor: { type: Number, required: true, min: 0 },
    outcome: { type: String, required: true, enum: ['ok', 'parse_failed', 'api_error'] },
  },
  { collection: 'extraction_costs', timestamps: false },
);
extractionCostSchema.index({ dayKey: 1, creatorId: 1 });

type ExtractionCostDoc = InferSchemaType<typeof extractionCostSchema>;
export const ExtractionCostModel: Model<ExtractionCostDoc> = model<ExtractionCostDoc>(
  'ExtractionCost',
  extractionCostSchema,
);

export function utcDayKey(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export interface SpendVerdict {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly spentTodayMinor: number;
  readonly ceilingMinor: number;
  readonly creatorExtractionsToday: number;
  readonly creatorCap: number;
}

/**
 * Checked BEFORE a call is made, never after. The ceiling is a hard stop: at or
 * above it, extraction refuses to run rather than warning and continuing.
 */
export async function checkSpendAllowance(creatorId: Types.ObjectId): Promise<SpendVerdict> {
  const env = loadEnv();
  const dayKey = utcDayKey();

  const [globalRows, creatorCount] = await Promise.all([
    ExtractionCostModel.aggregate<{ total: number }>([
      { $match: { dayKey } },
      { $group: { _id: null, total: { $sum: '$estimatedCostMinor' } } },
    ]),
    ExtractionCostModel.countDocuments({ dayKey, creatorId, outcome: { $ne: 'api_error' } }),
  ]);

  const spentTodayMinor = globalRows[0]?.total ?? 0;
  const ceilingMinor = env.EXTRACTION_DAILY_SPEND_CEILING_MINOR;
  const creatorCap = env.EXTRACTION_PER_CREATOR_DAILY_CAP;

  if (spentTodayMinor >= ceilingMinor) {
    return {
      allowed: false,
      reason: `Daily extraction spend ceiling reached (${spentTodayMinor} of ${ceilingMinor} pence). Extraction is stopped until tomorrow.`,
      spentTodayMinor,
      ceilingMinor,
      creatorExtractionsToday: creatorCount,
      creatorCap,
    };
  }

  if (creatorCount >= creatorCap) {
    return {
      allowed: false,
      reason: `This creator has reached the daily extraction cap of ${creatorCap}. Their submissions are queued, not lost.`,
      spentTodayMinor,
      ceilingMinor,
      creatorExtractionsToday: creatorCount,
      creatorCap,
    };
  }

  return {
    allowed: true,
    reason: null,
    spentTodayMinor,
    ceilingMinor,
    creatorExtractionsToday: creatorCount,
    creatorCap,
  };
}

export async function recordExtractionCost(entry: {
  creatorId: Types.ObjectId;
  postId: Types.ObjectId;
  attempt: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMinor: number;
  outcome: 'ok' | 'parse_failed' | 'api_error';
}): Promise<void> {
  const now = new Date();
  await ExtractionCostModel.create({ at: now, dayKey: utcDayKey(now), ...entry });

  // Alert on crossing the ceiling, once, at the moment it happens. The operator
  // dashboard shows cumulative spend continuously; this is the push.
  const env = loadEnv();
  const rows = await ExtractionCostModel.aggregate<{ total: number }>([
    { $match: { dayKey: utcDayKey(now) } },
    { $group: { _id: null, total: { $sum: '$estimatedCostMinor' } } },
  ]);
  const total = rows[0]?.total ?? 0;
  if (total >= env.EXTRACTION_DAILY_SPEND_CEILING_MINOR && total - entry.estimatedCostMinor < env.EXTRACTION_DAILY_SPEND_CEILING_MINOR) {
    console.error(
      `[extraction] DAILY SPEND CEILING REACHED: ${total} of ${env.EXTRACTION_DAILY_SPEND_CEILING_MINOR} pence. Extraction halted.`,
    );
    await recordAudit({
      actorKind: 'system',
      actorLabel: 'extraction worker',
      action: AUDIT.extractionSpendCeiling,
      detail: { spentMinor: total, ceilingMinor: env.EXTRACTION_DAILY_SPEND_CEILING_MINOR },
    });
    // Delivery is a step-7 concern; the alert address is validated at boot so
    // this is a wiring gap, not a silent failure.
    if (env.EXTRACTION_ALERT_EMAIL) {
      console.error(`[extraction] alert would be sent to ${env.EXTRACTION_ALERT_EMAIL}`);
    }
  }
}

/** For the operator dashboard. */
export async function spendSummary(days = 7): Promise<
  { dayKey: string; totalMinor: number; extractions: number }[]
> {
  const since = utcDayKey(new Date(Date.now() - days * 86_400_000));
  return ExtractionCostModel.aggregate([
    { $match: { dayKey: { $gte: since } } },
    { $group: { _id: '$dayKey', totalMinor: { $sum: '$estimatedCostMinor' }, extractions: { $sum: 1 } } },
    { $project: { _id: 0, dayKey: '$_id', totalMinor: 1, extractions: 1 } },
    { $sort: { dayKey: -1 } },
  ]);
}
