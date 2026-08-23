import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../config/env.js';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import type { PostFormat } from '@anton/shared';

/**
 * The vision client, behind an interface so tests never hit the network and so
 * a Phase 2 OAuth adapter can sit beside it under the same ingestion contract.
 */

export interface VisionRequest {
  readonly imageBase64: string;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  readonly declaredFormat: PostFormat;
  readonly declaredPlatform: 'instagram' | 'tiktok';
}

export interface VisionResponse {
  readonly rawText: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Minor units. Estimated from token counts, never billed exactly. */
  readonly estimatedCostMinor: number;
}

export interface VisionClient {
  extract(request: VisionRequest): Promise<VisionResponse>;
}

/**
 * Claude Sonnet pricing, US dollars per million tokens, as at build time.
 *
 * These are a COST ESTIMATE for the spend ceiling, not an invoice. Anthropic's
 * published rates change; the ceiling is a safety rail, so an estimate drifting
 * a few percent is acceptable where an unbounded spend is not. Update these
 * alongside any model change.
 */
const PRICE_PER_MTOK_INPUT_USD = 3;
const PRICE_PER_MTOK_OUTPUT_USD = 15;
/** Rough GBP conversion for the ceiling, which is denominated in pence. */
const USD_TO_GBP = 0.79;

export function estimateCostMinor(inputTokens: number, outputTokens: number): number {
  const usd =
    (inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT_USD +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT_USD;
  return Math.ceil(usd * USD_TO_GBP * 100);
}

export class AnthropicVisionClient implements VisionClient {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async extract(request: VisionRequest): Promise<VisionResponse> {
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: request.mediaType, data: request.imageBase64 },
            },
            {
              type: 'text',
              text: buildUserPrompt({
                declaredFormat: request.declaredFormat,
                declaredPlatform: request.declaredPlatform,
              }),
            },
          ],
        },
      ],
    });

    const rawText = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const inputTokens = message.usage.input_tokens;
    const outputTokens = message.usage.output_tokens;

    return {
      rawText,
      model: this.model,
      promptVersion: PROMPT_VERSION,
      inputTokens,
      outputTokens,
      estimatedCostMinor: estimateCostMinor(inputTokens, outputTokens),
    };
  }
}

let cached: VisionClient | null = null;

export function getVisionClient(): VisionClient {
  if (cached) return cached;
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set; extraction cannot run');
  }
  cached = new AnthropicVisionClient(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL);
  return cached;
}

/** Tests inject a stub through this. */
export function setVisionClient(client: VisionClient | null): void {
  cached = client;
}
