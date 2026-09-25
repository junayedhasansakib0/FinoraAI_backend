/**
 * Shared types for the AI reports module (ARCHITECTURE.md §7 AI, §8). `REPORT_TYPES` are Phase 11's
 * four *generatable* aggregate reports — each maps to one endpoint, one system prompt, one output
 * schema. The `QA` kind the schema permits (§5) is not generated on demand like those four (it is
 * produced by the Phase 12 chat endpoint from a free-text question), so it is deliberately kept out
 * of `REPORT_TYPES`; it appears only in `HISTORY_REPORT_TYPES`, which the history filter accepts.
 */

/** The four report kinds Phase 11 produces; each maps to one endpoint and one system prompt. */
export const REPORT_TYPES = [
  'SPENDING_ANALYSIS',
  'MONTHLY_SUMMARY',
  'SAVINGS_RECOMMENDATIONS',
  'BUDGET_RECOMMENDATIONS',
] as const;

export type ReportType = (typeof REPORT_TYPES)[number];

/** The Q&A report kind (Phase 12): persisted by the chat endpoint, never by a report generator. */
export const QA_REPORT_TYPE = 'QA' as const;

/** Every kind that can appear in stored history: the four reports plus QA (ARCHITECTURE.md §7). */
export const HISTORY_REPORT_TYPES = [...REPORT_TYPES, QA_REPORT_TYPE] as const;

export type ReportHistoryType = (typeof HISTORY_REPORT_TYPES)[number];

/**
 * A report as it goes on the wire. `content` is the validated AI output (R-I4) — always rendered
 * as plain text by the client, never HTML (R-I5/§8). For QA rows it is `{ question, answer }`.
 * `disclaimer` rides on every report so the "informational, not advice" line cannot be dropped
 * (R-I5). `cached` is true when the row was reused rather than freshly generated (24h reuse, R-I6).
 */
export interface PublicAIReport {
  id: string;
  type: ReportHistoryType;
  content: unknown;
  createdAt: string;
  disclaimer: string;
  cached: boolean;
}
