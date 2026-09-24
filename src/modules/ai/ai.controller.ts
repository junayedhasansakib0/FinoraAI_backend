import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';
import { getUserId } from '../../middleware/auth.js';
import { getValidatedQuery } from '../../middleware/validate.js';

import type { ReportType } from './ai.types.js';
import { generateReport, listReports } from './reports.service.js';
import type {
  MonthlySummaryBody,
  RefreshQuery,
  ReportsQuery,
} from './ai.validation.js';

/**
 * Transport layer for `/ai` (ARCHITECTURE.md §7). Each POST turns the authenticated user's ledger
 * into one report and returns it (with its disclaimer and `cached` flag) as `data`; a NO_DATA (422)
 * or RATE_LIMITED (429) from the service surfaces through the shared error handler. All business
 * rules — reuse, quota, aggregation, validation — live below this layer (R-B1).
 */

/** POST the four report kinds; only the monthly summary carries a body (the month it covers). */
async function generate(
  req: Request,
  res: Response,
  type: ReportType,
  params: { month?: number; year?: number },
): Promise<void> {
  const { refresh } = getValidatedQuery<RefreshQuery>(req);
  const { report } = await generateReport(getUserId(req), type, params, { refresh });
  sendSuccess(res, 200, report);
}

export async function spendingAnalysis(req: Request, res: Response): Promise<void> {
  await generate(req, res, 'SPENDING_ANALYSIS', {});
}

export async function monthlySummary(req: Request, res: Response): Promise<void> {
  const { month, year } = req.body as MonthlySummaryBody;
  await generate(req, res, 'MONTHLY_SUMMARY', { month, year });
}

export async function savingsRecommendations(req: Request, res: Response): Promise<void> {
  await generate(req, res, 'SAVINGS_RECOMMENDATIONS', {});
}

export async function budgetRecommendations(req: Request, res: Response): Promise<void> {
  await generate(req, res, 'BUDGET_RECOMMENDATIONS', {});
}

/** GET the user's recent reports, newest first, optionally filtered to one kind. */
export async function reportsHistory(req: Request, res: Response): Promise<void> {
  const { type, limit } = getValidatedQuery<ReportsQuery>(req);
  sendSuccess(res, 200, { reports: await listReports(getUserId(req), { type, limit }) });
}
