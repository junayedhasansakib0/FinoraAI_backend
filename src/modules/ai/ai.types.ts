/**
 * Shared types for the AI reports module (ARCHITECTURE.md §7 AI, §8). The report kinds here are
 * Phase 11's four aggregate reports; the `QA` kind the schema permits (§5) is Phase 12's business
 * and is deliberately absent from this list so nothing routes to it yet.
 */

/** The four report kinds Phase 11 produces; each maps to one endpoint and one system prompt. */
export const REPORT_TYPES = [
  'SPENDING_ANALYSIS',
  'MONTHLY_SUMMARY',
  'SAVINGS_RECOMMENDATIONS',
  'BUDGET_RECOMMENDATIONS',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/**
 * A report as it goes on the wire. `content` is the validated AI output (R-I4) — always rendered
 * as plain text by the client, never HTML (R-I5/§8). `disclaimer` rides on every report so the
 * "informational, not advice" line cannot be dropped (R-I5). `cached` is true when the row was
 * reused rather than freshly generated (24h reuse, R-I6).
 */
export interface PublicAIReport {
  id: string;
  type: ReportType;
  content: unknown;
  createdAt: string;
  disclaimer: string;
  cached: boolean;
}
