/** Shared server constants. Defined once and imported everywhere (R-N5). */

/** Versioned API base path (ARCHITECTURE.md §7). */
export const API_BASE_PATH = '/api/v1';

/** Public health probe path (ARCHITECTURE.md §7). */
export const HEALTH_PATH = '/health';

/** Request body size cap (R-A8). */
export const JSON_BODY_LIMIT = '1mb';

/** bcrypt work factor (R-A1). */
export const BCRYPT_COST = 12;

/** Minimum password length (ARCHITECTURE.md §6). */
export const PASSWORD_MIN_LENGTH = 8;

/** Access token lifetime: 15 minutes, in seconds (ARCHITECTURE.md §6). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh token lifetime: 30 days, in seconds (ARCHITECTURE.md §6). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Token cookie names and scopes (R-A3). The refresh cookie is scoped to the auth routes so
 * it is not attached to every API call, which shrinks its exposure.
 */
export const AUTH_COOKIES = {
  access: { name: 'finora_at', path: '/' },
  refresh: { name: 'finora_rt', path: `${API_BASE_PATH}/auth` },
} as const;

/**
 * Shared request validation limits (ARCHITECTURE.md §7). Every module validates against these
 * rather than its own copy of the numbers.
 */

/** Money is always positive and never more precise than the `Decimal(14,2)` columns (R-D2). */
export const MONEY_MIN = 0.01;
export const MONEY_MAX = 999_999_999.99;
export const MONEY_DECIMAL_PLACES = 2;

/** Free-text caps: names (people, categories, goals) and transaction descriptions. */
export const NAME_MAX_LENGTH = 60;
export const DESCRIPTION_MAX_LENGTH = 280;

/**
 * Bounds for a batched `$transaction` (Prisma interactive transaction). The library defaults are
 * `maxWait` 2s / `timeout` 5s, which are too tight for a cold or pooled free-tier Postgres
 * connection (Supabase): after an idle period a single round trip can itself approach a second, so
 * the batch fails to even START the transaction ("Unable to start a transaction in the given time")
 * and the read 500s. These give a batch room to begin and finish on a slow connection without ever
 * masking a database that is genuinely down — a real outage still surfaces as an error (R-E6, §8).
 */
export const DB_TRANSACTION_MAX_WAIT_MS = 15_000;
export const DB_TRANSACTION_TIMEOUT_MS = 20_000;

/** Pagination defaults and the hard page-size ceiling (R-B8). */
export const PAGE_DEFAULT = 1;
export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;

/**
 * `GET /categories` is a plain list in the contract (§7), so the only way to keep the response
 * bounded (R-B8) is to bound the collection itself. Far above what anyone organises by hand.
 */
export const MAX_CATEGORIES_PER_USER = 200;

/**
 * Dashboard shape (ARCHITECTURE.md §7). Six months is the analytics default and what §3's bar
 * chart draws; a year is the ceiling, so the series stays bounded whatever is asked for (R-B8).
 */
export const ANALYTICS_MONTHS_DEFAULT = 6;
export const ANALYTICS_MONTHS_MAX = 12;

/** The summary carries the five newest transactions (§7). */
export const DASHBOARD_RECENT_LIMIT = 5;

/** A donut stops being readable past a handful of slices, so the rest are rolled up (R-B8). */
export const DASHBOARD_BREAKDOWN_LIMIT = 8;


/**
 * A transaction may be dated at most one day ahead (R-V3): enough for a timezone that is ahead
 * of the server, not enough to book next month's spending.
 */
export const FUTURE_DATE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Rate limit defaults (R-B10). Route-specific limiters are added by their own phase. */
export const RATE_LIMITS = {
  global: { windowMs: 15 * 60 * 1000, limit: 300 },
  auth: { windowMs: 15 * 60 * 1000, limit: 20 },
  /**
   * External-backed endpoints (currency, crypto). Keyed per user rather than per IP so one
   * account cannot burn a shared upstream budget, and the cache absorbs the rest (R-B10, R-E6).
   */
  external: { windowMs: 60 * 1000, limit: 30 },
  /**
   * Resend-verification (email verification phase). Tighter than the general auth budget: sending
   * an email is a metered free-tier action and an open resend endpoint is an email-flood vector, so
   * it is capped hard and keyed per IP. The generic response is identical whether or not the email
   * exists (anti-enumeration), so the limit reveals nothing either.
   */
  resendVerification: { windowMs: 60 * 60 * 1000, limit: 5 },
} as const;

/**
 * Email verification (soft-gate phase). The token is high-entropy random bytes; only its SHA-256
 * hash is ever stored. It is valid for 24h, after which the user must request a fresh one. These
 * are the single source of truth for the token's shape and lifetime (R-N5).
 */
export const VERIFICATION_TOKEN_BYTES = 32;
export const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * AI generation limits (R-I6 / R-B10). The per-user caps themselves live in `env`
 * (`AI_HOURLY_LIMIT` / `AI_DAILY_LIMIT`) so a deployment can tune them; only the fixed window
 * durations and the provider ceiling live here, so each number has exactly one home (R-Doc3).
 * The AI Service enforces these caps in-process — the free-tier providers sit far above them,
 * so this quota, not the upstream, is the limit a user meets first.
 */
export const AI_HOURLY_WINDOW_MS = 60 * 60 * 1000;
export const AI_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hard ceiling on a single provider call (R-I6). Matches the 20s the AI Service allows. */
export const AI_PROVIDER_TIMEOUT_MS = 20_000;

/** One generation attempt plus a single repair retry when the first output fails validation (R-I4). */
export const AI_MAX_GENERATION_ATTEMPTS = 2;

/** Default output-token ceiling for a structured report; keeps responses bounded (R-B8). */
export const AI_MAX_OUTPUT_TOKENS = 1024;

/**
 * AI report context shaping (ARCHITECTURE.md §8, PROJECT_CONTEXT.md §5). Context builders emit
 * aggregates only, over a bounded window and a capped number of categories, so the prompt stays
 * small and the prompt-injection surface stays tiny (D7, R-I1).
 */

/** Spending analysis looks back six months of category totals and MoM deltas (§5: "3–6 months"). */
export const AI_SPENDING_MONTHS = 6;

/** Budget and savings recommendations average the last three months (§5). */
export const AI_AVERAGE_MONTHS = 3;

/**
 * Financial Q&A (Phase 12, PROJECT_CONTEXT.md §5): the snapshot the chat context builds spans the
 * current month plus the two before it, enough for a month-over-month answer while the prompt (and
 * its injection surface) stays small (D7, R-I1).
 */
export const AI_QA_MONTHS = 3;

/** A Q&A question is capped before it ever reaches a prompt (ARCHITECTURE.md §7, R-I3/R-V1). */
export const AI_CHAT_QUESTION_MAX = 500;

/**
 * Cap on a validated Q&A answer (R-I4). Larger than a report caption because an answer may span a
 * short paragraph, but still well under the output-token ceiling so a runaway reply cannot bloat a
 * stored row or the client.
 */
export const AI_QA_ANSWER_MAX = 1_200;

/** Never send more than the top handful of categories, mirroring the dashboard donut (R-B8). */
export const AI_TOP_CATEGORIES = 8;

/**
 * Rough character budget for a built context, ~1.2k tokens at ~4 chars/token (ARCHITECTURE.md §8).
 * Builders are bounded by construction; this is the guard a test asserts against.
 */
export const AI_CONTEXT_MAX_CHARS = 4_800;

/** A report is reused rather than regenerated while it is younger than 24h (R-I6). */
export const AI_REPORT_REUSE_MS = 24 * 60 * 60 * 1000;

/** `GET /ai/reports` history page size and its hard ceiling (R-B8). */
export const AI_REPORTS_HISTORY_DEFAULT = 10;
export const AI_REPORTS_HISTORY_MAX = 50;

/** Caps on validated AI output (R-I4): a single text field and a single list of points. */
export const AI_OUTPUT_TEXT_MAX = 800;
export const AI_OUTPUT_LIST_MAX = 12;
