import { z } from 'zod';
import { CURRENCY_CODES, METRIC_SOURCES, PLATFORMS, POST_FORMATS } from '../types/common.js';

/** 24-char hex Mongo ObjectId, as a string at the API boundary. */
export const objectIdSchema = z
  .string()
  .regex(/^[a-f0-9]{24}$/i, 'must be a 24-character hex ObjectId');

export const platformSchema = z.enum(PLATFORMS);
export const postFormatSchema = z.enum(POST_FORMATS);
export const metricSourceSchema = z.enum(METRIC_SOURCES);
export const currencyCodeSchema = z.enum(CURRENCY_CODES);

/** Money is always integer minor units. A float here is a bug, not a rounding. */
export const moneySchema = z.object({
  amountMinor: z
    .number()
    .int('money must be whole minor units (pence/cents), never a float')
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  currency: currencyCodeSchema,
});

export const isoCountrySchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, uppercase');

export const languageCodeSchema = z
  .string()
  .min(2)
  .max(3)
  .regex(/^[a-z]{2,3}$/, 'ISO 639-1, lowercase');

export const httpUrlSchema = z
  .url()
  .refine((u) => u.startsWith('https://') || u.startsWith('http://'), {
    message: 'must be an http(s) URL',
  });

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase hex sha256');

/** A handle without '@', lowercased, platform-legal characters only. */
export const handleSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9._]+$/, "lowercase letters, digits, '.' and '_' only; no leading '@'");

export const nicheTagSchema = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/, 'kebab-case tag');

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
