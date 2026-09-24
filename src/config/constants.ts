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
} as const;
