import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { engagementRate, isReportable, totalEngagements, type PostMetrics } from '@anton/shared';
import { AuditLogModel, CampaignModel, CreatorModel, PostModel } from '../db/models/index.js';
import { getOperator, requireFreshReauth, requireOperator } from '../lib/operator-session.js';
import { ApiError } from '../lib/errors.js';
import { asyncRoute, parseQuery } from '../lib/validate.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { hashIp } from '../config/consent.js';
import { clientIp } from '../lib/creator-session.js';
import { purgeExpiredData } from '../retention/purge.js';

export const operatorExportRouter: Router = Router();
operatorExportRouter.use(requireOperator);

/**
 * Bulk export.
 *
 * Behind requireFreshReauth: this hands over every creator's analytics in one
 * file, which is exactly the action a stolen session would be used for.
 */

/** RFC 4180 escaping. A creator's niche list contains commas. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map(csvCell).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c])).join(',')).join('\n');
  return `${header}\n${body}\n`;
}

const exportQuerySchema = z.object({
  campaignId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  format: z.enum(['csv', 'json']).default('csv'),
  /** Reportable posts only, by default. The other rows are unestablished. */
  includeUnverified: z.enum(['true', 'false']).default('false'),
});

operatorExportRouter.get(
  '/export/posts',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const query = parseQuery(exportQuerySchema, req);
    const { operator } = getOperator(req);

    const filter: Record<string, unknown> = {};
    if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);

    const posts = await PostModel.find(filter).sort({ postedAt: -1 }).lean();
    const [creators, campaigns] = await Promise.all([
      CreatorModel.find({ _id: { $in: posts.map((p) => p.creatorId) } }).lean(),
      CampaignModel.find({ _id: { $in: posts.map((p) => p.campaignId) } }).lean(),
    ]);

    const rows = posts
      .filter((p) => {
        if (query.includeUnverified === 'true') return true;
        return isReportable({
          metricSource: p.metricSource,
          extractionStatus: p.extraction?.status ?? null,
        } as Parameters<typeof isReportable>[0]);
      })
      .map((p) => {
        const creator = creators.find((c) => String(c._id) === String(p.creatorId));
        const campaign = campaigns.find((c) => String(c._id) === String(p.campaignId));
        const metrics = p.metrics as PostMetrics;
        return {
          postId: p._id.toString(),
          campaign: campaign?.name ?? '',
          creator: creator?.displayName ?? '',
          handle: creator?.handles?.[0]?.handle ?? '',
          niches: (creator?.nicheTags ?? []).join('; '),
          platform: p.platform,
          format: p.format,
          postedAt: p.postedAt.toISOString(),
          publicUrl: p.publicUrl ?? '',
          reach: metrics.reach,
          impressions: metrics.impressions,
          likes: metrics.likes,
          comments: metrics.comments,
          shares: metrics.shares,
          saves: metrics.saves,
          profileVisits: metrics.profileVisits,
          linkClicks: metrics.linkClicks,
          videoViews: metrics.videoViews,
          watchTimeSeconds: metrics.watchTimeSeconds,
          followsFromPost: metrics.followsFromPost,
          engagements: totalEngagements(metrics).value,
          engagementRate: engagementRate(metrics).value,
          // Provenance travels with the export. A CSV that outlives its context
          // must still say where its numbers came from.
          metricSource: p.metricSource,
          extractionStatus: p.extraction?.status ?? '',
          instructionTextDetected: p.extraction?.instructionTextDetected ?? false,
          manualOverrides: p.manualOverrides.length,
          verifiedAt: p.verifiedAt?.toISOString() ?? '',
          sourceImageSha256: p.extraction?.sourceImageSha256 ?? '',
        };
      });

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.operatorBulkExport,
      detail: { rows: rows.length, campaignId: query.campaignId ?? null, format: query.format },
      ipHash: hashIp(clientIp(req)),
    });

    const stamp = new Date().toISOString().slice(0, 10);
    if (query.format === 'json') {
      res.setHeader('content-disposition', `attachment; filename="anton-posts-${stamp}.json"`);
      res.json({
        exportedAt: new Date(),
        note: 'Screenshot-sourced figures are creator-reported with a source image on file, not platform-verified.',
        rows,
      });
      return;
    }

    const columns = Object.keys(rows[0] ?? { postId: '' });
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="anton-posts-${stamp}.csv"`);
    res.send(toCsv(rows, columns));
  }),
);

/** The append-only audit trail, for review or handover. */
operatorExportRouter.get(
  '/export/audit',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const { operator } = getOperator(req);
    const limit = Math.min(Number(req.query.limit ?? 5_000), 20_000);
    const entries = await AuditLogModel.find({}).sort({ at: -1 }).limit(limit).lean();

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: 'operator.audit.exported',
      detail: { rows: entries.length },
      ipHash: hashIp(clientIp(req)),
    });

    res.setHeader('content-disposition', 'attachment; filename="anton-audit.json"');
    res.json({ exportedAt: new Date(), entries });
  }),
);

/* ------------------------------------------------------------- retention */

operatorExportRouter.get(
  '/retention/preview',
  asyncRoute(async (_req, res) => {
    res.json(await purgeExpiredData(true));
  }),
);

operatorExportRouter.post(
  '/retention/purge',
  requireFreshReauth,
  asyncRoute(async (req, res) => {
    const { operator } = getOperator(req);
    const confirm = (req.body as { confirm?: unknown }).confirm;
    if (confirm !== 'PURGE') {
      throw ApiError.badRequest('confirm_required', 'Type PURGE to confirm.');
    }

    const result = await purgeExpiredData(false);

    await recordAudit({
      actorKind: 'operator',
      actorId: operator._id,
      actorLabel: operator.email,
      action: AUDIT.operatorBulkDelete,
      detail: { creatorsPurged: result.creatorsPurged, postsDeleted: result.postsDeleted },
      ipHash: hashIp(clientIp(req)),
    });

    res.json(result);
  }),
);
