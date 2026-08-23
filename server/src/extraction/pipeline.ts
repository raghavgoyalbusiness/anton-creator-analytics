import type { Types } from 'mongoose';
import {
  EMPTY_METRICS,
  evaluatePlausibility,
  followerCountAsOf,
  parseVisionResponse,
  routeByConfidence,
  type MetricKey,
  type Platform,
  type PostMetrics,
} from '@anton/shared';
import { CampaignModel, CreatorModel, PostModel } from '../db/models/index.js';
import { getStorage } from '../storage/index.js';
import { loadEnv } from '../config/env.js';
import { AUDIT, recordAudit } from '../lib/audit.js';
import { getVisionClient, type VisionClient, type VisionResponse } from './client.js';
import { PROMPT_VERSION, notesFlagInstructionText } from './prompt.js';
import { checkSpendAllowance, recordExtractionCost } from './spend.js';
import {
  CROSS_CHECK_NOT_ATTEMPTED,
  assessHistoricalDeviation,
  crossCheckPublicPost,
} from './trust.js';

/**
 * The extraction pipeline.
 *
 * One post in, one decided ExtractionRecord out. Every failure mode ends with
 * the post in a defined state carrying a reason a human can act on: nothing is
 * left pending silently, and nothing reaches a brand without either passing
 * every check or being signed off by a person.
 */

export interface ExtractionOutcome {
  readonly postId: string;
  readonly status: 'auto_accepted' | 'needs_review' | 'skipped';
  readonly reasons: readonly string[];
  readonly attempts: number;
  readonly costMinor: number;
}

/** Sleep with exponential backoff. Bounded by EXTRACTION_MAX_ATTEMPTS. */
function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1));
}

export async function extractPost(
  postId: Types.ObjectId,
  client: VisionClient = getVisionClient(),
): Promise<ExtractionOutcome> {
  const env = loadEnv();
  const post = await PostModel.findById(postId);
  if (!post) throw new Error(`post ${postId.toString()} not found`);
  if (post.extraction == null) throw new Error(`post ${postId.toString()} has no extraction record`);
  if (post.extraction.status !== 'pending') {
    return { postId: postId.toString(), status: 'skipped', reasons: ['already processed'], attempts: 0, costMinor: 0 };
  }

  const spend = await checkSpendAllowance(post.creatorId);
  if (!spend.allowed) {
    // Left pending on purpose: the submission is not lost, it is queued until
    // tomorrow. Marking it needs_review would put a post with no numbers in
    // front of an operator who can do nothing about it.
    return {
      postId: postId.toString(),
      status: 'skipped',
      reasons: [spend.reason ?? 'spend ceiling'],
      attempts: 0,
      costMinor: 0,
    };
  }

  const [creator, campaign] = await Promise.all([
    CreatorModel.findById(post.creatorId).lean(),
    CampaignModel.findById(post.campaignId).lean(),
  ]);
  if (!creator || !campaign) throw new Error(`post ${postId.toString()} has a dangling reference`);

  const storage = getStorage();
  const imageBytes = await storage.readObject(post.extraction.sourceImageKey);

  /* ---------------------------------------------------------- model call */

  let response: VisionResponse | null = null;
  let lastError: string | null = null;
  let attempts = 0;
  let costMinor = 0;

  // Bounded retries with backoff. Never an unbounded loop: a persistently
  // failing image would otherwise burn the daily ceiling on one post.
  while (attempts < env.EXTRACTION_MAX_ATTEMPTS && response === null) {
    attempts += 1;
    try {
      response = await client.extract({
        imageBase64: imageBytes.toString('base64'),
        mediaType: 'image/jpeg',
        declaredFormat: post.format,
        declaredPlatform: post.platform,
      });
      costMinor += response.estimatedCostMinor;
      await recordExtractionCost({
        creatorId: post.creatorId,
        postId: post._id,
        attempt: attempts,
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        estimatedCostMinor: response.estimatedCostMinor,
        outcome: 'ok',
      });
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : 'unknown API error';
      await recordExtractionCost({
        creatorId: post.creatorId,
        postId: post._id,
        attempt: attempts,
        model: env.ANTHROPIC_MODEL,
        inputTokens: null,
        outputTokens: null,
        estimatedCostMinor: 0,
        outcome: 'api_error',
      });
      if (attempts < env.EXTRACTION_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs(attempts)));
      }
    }
  }

  if (response === null) {
    return finalise(post, {
      metrics: EMPTY_METRICS,
      fieldConfidence: {},
      rawResponse: '',
      parseOk: false,
      parseError: lastError ?? 'the model could not be reached',
      model: env.ANTHROPIC_MODEL,
      detectedPlatform: null,
      detectedScreenType: null,
      modelNotes: null,
      status: 'needs_review',
      reasons: [
        `The model could not be reached after ${attempts} attempts. Last error: ${lastError ?? 'unknown'}.`,
      ],
      attempts,
      costMinor,
      instructionTextDetected: false,
    });
  }

  /* -------------------------------------------------------------- parse */

  const parsed = parseVisionResponse(response.rawText);

  if (!parsed.ok) {
    return finalise(post, {
      metrics: EMPTY_METRICS,
      fieldConfidence: {},
      rawResponse: response.rawText,
      parseOk: false,
      parseError: `${parsed.stage}: ${parsed.error}`,
      model: response.model,
      detectedPlatform: null,
      detectedScreenType: null,
      modelNotes: null,
      status: 'needs_review',
      reasons: [
        `The model did not return usable JSON (${parsed.stage}). Its exact output is stored for inspection.`,
      ],
      attempts,
      costMinor,
      instructionTextDetected: false,
    });
  }

  /* ------------------------------------------- prompt-injection handling */

  const instructionTextDetected = notesFlagInstructionText(parsed.envelope.notes);
  const injectionReasons: string[] = [];

  if (instructionTextDetected) {
    // Loud, and the numbers do not auto-accept. The model says it saw text in
    // the image trying to steer it; whether or not it resisted, a human looks.
    injectionReasons.push(
      'The model reported instruction-like text inside this image. It was told to ignore it, but this submission and this creator need a look.',
    );
    console.error(
      `[extraction] INSTRUCTION TEXT DETECTED in post ${post._id.toString()} from creator ${post.creatorId.toString()}`,
    );
    await recordAudit({
      actorKind: 'system',
      actorLabel: 'extraction worker',
      action: AUDIT.promptInjectionDetected,
      subjectKind: 'Post',
      subjectId: post._id,
      detail: {
        creatorId: post.creatorId.toString(),
        notes: parsed.envelope.notes,
        sourceImageKey: post.extraction.sourceImageKey,
      },
    });
  }

  const screenType = parsed.envelope.screen_type;
  const metrics: PostMetrics = parsed.metrics;

  /* ------------------------------------------------------- plausibility */

  const followerSnapshot = followerCountAsOf(
    (creator.followerSnapshots ?? []).map((s) => ({
      platform: s.platform as Platform,
      count: s.count,
      capturedAt: s.capturedAt,
      source: s.source as 'manual' | 'screenshot' | 'oauth',
    })),
    post.platform,
    post.postedAt,
  );

  const plausibility = evaluatePlausibility({
    metrics,
    postedAt: post.postedAt,
    campaignStartDate: campaign.startDate,
    followerCountAtPost: followerSnapshot?.count ?? null,
    now: new Date(),
  });

  const routing = routeByConfidence({
    metrics,
    fieldConfidence: parsed.fieldConfidence,
    plausibility,
    screenType,
  });

  /* -------------------------------------------------------- trust signals */

  const priorPosts = await PostModel.find({
    creatorId: post.creatorId,
    _id: { $ne: post._id },
    'extraction.status': { $in: ['auto_accepted', 'verified'] },
  })
    .select('metrics')
    .lean();

  const deviation = assessHistoricalDeviation(
    metrics,
    priorPosts.map((p) => p.metrics as PostMetrics),
  );

  const crossCheck = post.publicUrl
    ? await crossCheckPublicPost(post.publicUrl, metrics)
    : CROSS_CHECK_NOT_ATTEMPTED;

  const trustReasons: string[] = [];
  if (deviation.exceededThreshold && deviation.deviationMultiple !== null) {
    trustReasons.push(
      `Engagement rate is ${deviation.deviationMultiple.toFixed(1)}x this creator's own median across ${deviation.sampleSize} prior posts.`,
    );
  }
  if (crossCheck.status === 'diverged') {
    trustReasons.push(crossCheck.note ?? 'Public counts diverge from the submitted figures.');
  }
  if (post.trust?.withinSubmissionWindow === false) {
    trustReasons.push(
      `Submitted ${Math.round(post.trust.submissionLagHours ?? 0)} hours after posting, outside the ${env.SUBMISSION_WINDOW_HOURS}-hour window.`,
    );
  }
  if (post.trust?.flaggedForSpotAudit) {
    trustReasons.push('Selected for a spot audit. Arrange a live screen share before this is reported.');
  }

  const allReasons = [...injectionReasons, ...routing.reasons, ...trustReasons];
  // A trust signal or an injection flag holds a post back even when the numbers
  // themselves look impeccable — that is precisely the case worth catching.
  const status = allReasons.length === 0 ? 'auto_accepted' : 'needs_review';

  await PostModel.updateOne(
    { _id: post._id },
    {
      $set: {
        'trust.historicalDeviation': deviation,
        'trust.publicCrossCheck': crossCheck,
      },
    },
  );

  return finalise(post, {
    metrics,
    fieldConfidence: parsed.fieldConfidence,
    rawResponse: response.rawText,
    parseOk: true,
    parseError: null,
    model: response.model,
    detectedPlatform: parsed.envelope.platform,
    detectedScreenType: screenType,
    modelNotes: parsed.envelope.notes || null,
    plausibility,
    status,
    reasons: allReasons,
    attempts,
    costMinor,
    instructionTextDetected,
  });
}

interface FinaliseInput {
  metrics: PostMetrics;
  fieldConfidence: Readonly<Partial<Record<MetricKey, number>>>;
  rawResponse: string;
  parseOk: boolean;
  parseError: string | null;
  model: string;
  detectedPlatform: string | null;
  detectedScreenType: string | null;
  modelNotes: string | null;
  plausibility?: ReturnType<typeof evaluatePlausibility>;
  status: 'auto_accepted' | 'needs_review';
  reasons: readonly string[];
  attempts: number;
  costMinor: number;
  instructionTextDetected: boolean;
}

async function finalise(
  post: { _id: Types.ObjectId; creatorId: Types.ObjectId },
  input: FinaliseInput,
): Promise<ExtractionOutcome> {
  const plausibility = input.plausibility ?? { passed: false, violations: [], skipped: [] };

  await PostModel.updateOne(
    { _id: post._id },
    {
      $set: {
        metrics: input.metrics,
        'extraction.extractedAt': new Date(),
        'extraction.model': input.model,
        'extraction.promptVersion': PROMPT_VERSION,
        // Stored verbatim, parsed or not. When a number is challenged, this
        // string plus the source image is the whole evidentiary chain.
        'extraction.rawResponse': input.rawResponse || '(no response body)',
        'extraction.parseOk': input.parseOk,
        'extraction.parseError': input.parseError,
        'extraction.detectedPlatform': input.detectedPlatform,
        'extraction.detectedScreenType': input.detectedScreenType,
        'extraction.modelNotes': input.modelNotes,
        'extraction.fieldConfidence': input.fieldConfidence,
        'extraction.plausibility': plausibility,
        'extraction.status': input.status,
        'extraction.routingReasons': input.reasons,
        'extraction.instructionTextDetected': input.instructionTextDetected,
      },
    },
  );

  await recordAudit({
    actorKind: 'system',
    actorLabel: 'extraction worker',
    action: AUDIT.postExtracted,
    subjectKind: 'Post',
    subjectId: post._id,
    detail: {
      status: input.status,
      attempts: input.attempts,
      parseOk: input.parseOk,
      reasonCount: input.reasons.length,
      instructionTextDetected: input.instructionTextDetected,
    },
  });

  return {
    postId: post._id.toString(),
    status: input.status,
    reasons: input.reasons,
    attempts: input.attempts,
    costMinor: input.costMinor,
  };
}

/** Drains pending posts, oldest first. Returns what it did. */
export async function drainPending(
  limit = 20,
  client?: VisionClient,
): Promise<ExtractionOutcome[]> {
  const pending = await PostModel.find({ 'extraction.status': 'pending' })
    .sort({ submittedAt: 1 })
    .limit(limit)
    .select('_id')
    .lean();

  const outcomes: ExtractionOutcome[] = [];
  for (const row of pending) {
    try {
      outcomes.push(await extractPost(row._id, client));
    } catch (err: unknown) {
      console.error(`[extraction] post ${row._id.toString()} threw:`, err);
    }
  }
  return outcomes;
}
