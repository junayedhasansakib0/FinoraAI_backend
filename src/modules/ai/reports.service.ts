import {
  AI_REPORTS_HISTORY_DEFAULT,
  AI_REPORT_REUSE_MS,
} from '../../config/constants.js';
import { generateStructured } from '../../ai/ai.service.js';
import type { AIProvider } from '../../ai/types.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';

import {
  readBudgetRecommendations,
  readMonthlySummary,
  readSavings,
  readSpendingAnalysis,
  contextString,
} from './analysis.service.js';
import type { PublicAIReport, ReportType } from './ai.types.js';
import { AI_DISCLAIMER, systemPromptFor, wrapContext } from './prompts.js';
import { outputSchemaFor } from './reports.schema.js';

/**
 * Report orchestration (ARCHITECTURE.md §8): ties the aggregate-only context (analysis.service) to
 * the AI Service and to persistence, and owns the 24h reuse rule (R-I6). The flow: reuse a fresh
 * enough stored report unless `refresh` is asked → else build context, and if the user has no data
 * to report on answer NO_DATA (422) → generate + validate through the AI Service → persist an
 * AIReport row (R-I7) → return it. A reused report costs no quota because it never reaches the AI
 * Service. Every returned report carries the disclaimer (R-I5). This module never calls a provider
 * directly and never reaches AI-provider internals (R-I2).
 */

/** What a stored report's `content` column holds: the validated AI output plus the month it covered. */
interface StoredContent {
  data: unknown;
  scope: ReportScope;
}

/** The month a report covers, for scope-aware reuse; null for the whole-history reports. */
type ReportScope = { month: number; year: number } | null;

/** Inputs a report may need beyond the user: the month a monthly summary covers. */
export interface ReportParams {
  month?: number;
  year?: number;
}

export interface ReportOptions {
  /** Bypass the 24h reuse and force a fresh generation (R-I6). */
  refresh?: boolean;
  /** Injected clock, threaded to both reuse reckoning and the quota window (R-T6). */
  now?: Date;
  /** Overrides the env-selected provider; tests inject the mock here (R-T4). */
  provider?: AIProvider;
}

export interface GeneratedReport {
  report: PublicAIReport;
  cached: boolean;
}

/** The scope a report kind covers: the requested month for a monthly summary, otherwise none. */
function scopeFor(type: ReportType, params: ReportParams): ReportScope {
  if (type !== 'MONTHLY_SUMMARY') return null;
  if (params.month === undefined || params.year === undefined) {
    throw new AppError('VALIDATION_ERROR', 'A month and year are required for a monthly summary.');
  }
  return { month: params.month, year: params.year };
}

/** Build the aggregate-only context for a report, or null when the user has no data to report on (R-I1). */
async function buildContext(
  userId: string,
  type: ReportType,
  scope: ReportScope,
  now: Date,
): Promise<unknown> {
  switch (type) {
    case 'SPENDING_ANALYSIS':
      return readSpendingAnalysis(userId, now);
    case 'MONTHLY_SUMMARY':
      // scope is non-null here: scopeFor guarantees it for MONTHLY_SUMMARY.
      return readMonthlySummary(userId, scope!.month, scope!.year);
    case 'SAVINGS_RECOMMENDATIONS':
      return readSavings(userId, now);
    case 'BUDGET_RECOMMENDATIONS':
      return readBudgetRecommendations(userId, now);
  }
}

/** True when two scopes describe the same month (or are both scope-less). */
function scopeMatches(a: ReportScope, b: ReportScope): boolean {
  if (a === null || b === null) return a === b;
  return a.month === b.month && a.year === b.year;
}

/**
 * The freshest stored report of this kind still inside the 24h window whose scope matches, if any.
 * The double cannot filter on a JSON column, so scope is matched in memory over a bounded page.
 */
async function findReusable(
  userId: string,
  type: ReportType,
  scope: ReportScope,
  now: Date,
): Promise<{ id: string; content: unknown; createdAt: Date } | null> {
  const cutoff = new Date(now.getTime() - AI_REPORT_REUSE_MS);
  const recent = await prisma.aIReport.findMany({
    where: { userId, type, createdAt: { gte: cutoff } },
    orderBy: [{ createdAt: 'desc' }],
    take: 20,
  });
  for (const row of recent) {
    const stored = row.content as unknown as StoredContent;
    if (scopeMatches(stored.scope ?? null, scope)) return row;
  }
  return null;
}

/** Shape a stored row for the wire: unwrap the validated output and attach the disclaimer (R-I5). */
function toPublicReport(
  row: { id: string; type: string; content: unknown; createdAt: Date },
  cached: boolean,
): PublicAIReport {
  const stored = row.content as StoredContent;
  return {
    id: row.id,
    type: row.type as ReportType,
    content: stored.data,
    createdAt: row.createdAt.toISOString(),
    disclaimer: AI_DISCLAIMER,
    cached,
  };
}

/**
 * Produce a report for the user: reuse a fresh stored one unless `refresh` is set (no quota cost),
 * otherwise build aggregate context (NO_DATA when there is nothing to report on), generate and
 * validate it through the AI Service, persist it (R-I7), and return it with its disclaimer.
 */
export async function generateReport(
  userId: string,
  type: ReportType,
  params: ReportParams,
  options: ReportOptions = {},
): Promise<GeneratedReport> {
  const now = options.now ?? new Date();
  const scope = scopeFor(type, params);

  if (options.refresh !== true) {
    const reusable = await findReusable(userId, type, scope, now);
    if (reusable) {
      return { report: toPublicReport({ ...reusable, type }, true), cached: true };
    }
  }

  const context = await buildContext(userId, type, scope, now);
  if (context === null) {
    throw new AppError('NO_DATA', 'There is not enough of your data yet to generate this report.');
  }

  const { data } = await generateStructured(
    userId,
    {
      system: systemPromptFor(type),
      user: wrapContext(contextString(context)),
      schema: outputSchemaFor(type),
    },
    { now: now.getTime(), provider: options.provider },
  );

  const content: StoredContent = { data, scope };
  const row = await prisma.aIReport.create({
    data: { userId, type, content: content as unknown as Prisma.InputJsonValue },
  });

  return { report: toPublicReport({ ...row, type }, false), cached: false };
}

/** The user's recent reports, newest first, optionally filtered to one kind (ARCHITECTURE.md §7). */
export async function listReports(
  userId: string,
  filter: { type?: ReportType; limit?: number } = {},
): Promise<PublicAIReport[]> {
  const rows = await prisma.aIReport.findMany({
    where: { userId, ...(filter.type ? { type: filter.type } : {}) },
    orderBy: [{ createdAt: 'desc' }],
    take: filter.limit ?? AI_REPORTS_HISTORY_DEFAULT,
  });
  return rows.map((row) => toPublicReport(row, true));
}

