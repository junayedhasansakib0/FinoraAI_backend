import { z, type ZodType } from 'zod';

import {
  AI_OUTPUT_LIST_MAX,
  AI_OUTPUT_TEXT_MAX,
  AI_QA_ANSWER_MAX,
} from '../../config/constants.js';

import type { ReportType } from './ai.types.js';

/**
 * Zod schemas for the AI's own output (R-I4). AI output is untrusted input: it is JSON-parsed, then
 * validated here, then (once) repaired, else the request fails 503 — the AI Service owns that loop.
 * These schemas are the cap: every string is length-bounded and every list is count-bounded, so a
 * runaway or hostile response cannot bloat a stored report or the client (R-I4, R-B8). Fields are
 * plain strings and string lists so the client can render them as text and never as HTML (R-I5).
 */

/** A single caption or sentence from the model, non-empty and length-capped. */
const shortText = z.string().min(1).max(AI_OUTPUT_TEXT_MAX);

/** A bounded list of captions; may be empty (a user can legitimately have nothing to report there). */
const shortList = z.array(shortText).max(AI_OUTPUT_LIST_MAX);

const spendingAnalysisOutput = z.object({
  summary: shortText,
  spendingPatterns: shortList,
  notableCategories: shortList,
  savingsOpportunities: shortList,
});

const monthlySummaryOutput = z.object({
  summary: shortText,
  observations: shortList,
  recommendations: shortList,
});

const savingsRecommendationsOutput = z.object({
  summary: shortText,
  recommendations: shortList,
  goalNotes: shortList,
});

const suggestedBudget = z.object({
  category: shortText,
  /** A plain number string the client displays; never used for server-side math (R-B3). */
  amount: z.string().min(1).max(32),
  rationale: shortText,
});

const budgetRecommendationsOutput = z.object({
  summary: shortText,
  suggestedBudgets: z.array(suggestedBudget).max(AI_OUTPUT_LIST_MAX),
  adjustments: shortList,
});

/** The validated output shapes, keyed by report kind. */
export const REPORT_OUTPUT_SCHEMAS: Record<ReportType, ZodType> = {
  SPENDING_ANALYSIS: spendingAnalysisOutput,
  MONTHLY_SUMMARY: monthlySummaryOutput,
  SAVINGS_RECOMMENDATIONS: savingsRecommendationsOutput,
  BUDGET_RECOMMENDATIONS: budgetRecommendationsOutput,
};

/** The schema a report kind's AI output must satisfy (R-I4). */
export function outputSchemaFor(type: ReportType): ZodType {
  return REPORT_OUTPUT_SCHEMAS[type];
}

/**
 * The Q&A answer's shape (Phase 12, R-I4). Untrusted model output like the reports above: a single
 * non-empty, length-capped plain-text string the client renders as text, never HTML (R-I5). The cap
 * is `AI_QA_ANSWER_MAX` — larger than a report caption because an answer may span a short paragraph.
 */
export const qaOutputSchema = z.object({
  answer: z.string().min(1).max(AI_QA_ANSWER_MAX),
});

export type SpendingAnalysisOutput = z.infer<typeof spendingAnalysisOutput>;
export type MonthlySummaryOutput = z.infer<typeof monthlySummaryOutput>;
export type SavingsRecommendationsOutput = z.infer<typeof savingsRecommendationsOutput>;
export type BudgetRecommendationsOutput = z.infer<typeof budgetRecommendationsOutput>;
export type QAOutput = z.infer<typeof qaOutputSchema>;
