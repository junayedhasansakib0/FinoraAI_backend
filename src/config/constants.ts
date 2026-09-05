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

/** Rate limit defaults (R-B10). Route-specific limiters are added by their own phase. */
export const RATE_LIMITS = {
  global: { windowMs: 15 * 60 * 1000, limit: 300 },
  auth: { windowMs: 15 * 60 * 1000, limit: 20 },
} as const;
