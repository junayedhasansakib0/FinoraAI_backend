import { z } from 'zod';

import {
  AI_CHAT_QUESTION_MAX,
  AI_REPORTS_HISTORY_DEFAULT,
  AI_REPORTS_HISTORY_MAX,
} from '../../config/constants.js';

import { HISTORY_REPORT_TYPES } from './ai.types.js';

/**
 * Request schemas for `/ai` (ARCHITECTURE.md §7, R-V1). The only body is the month a monthly
 * summary covers; the queries are the cache-busting `refresh` flag and the history filter. Report
 * *output* is validated separately in `reports.schema.ts` — that is untrusted model output (R-I4),
 * this is untrusted client input (R-V1).
 */

/** The month a monthly summary is asked for. Bounds match the budgets/analytics schemas (§7). */
export const monthlySummaryBodySchema = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
});

/**
 * `?refresh=true` forces a fresh generation past the 24h reuse (R-I6). Parsed strictly: only the
 * literal string `true` means true, so `?refresh=false` (and an absent flag) both read as false —
 * `z.coerce.boolean` would wrongly treat the string "false" as truthy.
 */
export const refreshQuerySchema = z.object({
  refresh: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((value) => value === 'true'),
});

/**
 * The free-text question the chat endpoint answers (Phase 12, R-V1/R-I3). Trimmed and length-capped
 * before it ever reaches a prompt; the prompt layer then delimiter-wraps it as untrusted data. The
 * cap is `AI_CHAT_QUESTION_MAX`; a blank or whitespace-only question fails validation (400).
 */
export const chatBodySchema = z.object({
  question: z.string().trim().min(1).max(AI_CHAT_QUESTION_MAX),
});

/** `GET /ai/reports` history filter: an optional kind and a bounded page size (R-B8). */
export const reportsQuerySchema = z.object({
  type: z.enum(HISTORY_REPORT_TYPES).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AI_REPORTS_HISTORY_MAX)
    .default(AI_REPORTS_HISTORY_DEFAULT),
});

export type MonthlySummaryBody = z.infer<typeof monthlySummaryBodySchema>;
export type RefreshQuery = z.infer<typeof refreshQuerySchema>;
export type ReportsQuery = z.infer<typeof reportsQuerySchema>;
export type ChatBody = z.infer<typeof chatBodySchema>;
