import type { CookieOptions, Response } from 'express';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTH_COOKIES,
  REFRESH_TOKEN_TTL_SECONDS,
} from '../config/constants.js';
import { env } from '../config/env.js';

/**
 * Tokens travel only in HttpOnly cookies — never in a response body, never in web storage
 * (R-A3). SameSite=Lax blocks cross-site POSTs from carrying them; Secure is on outside
 * development, where localhost is served over plain HTTP.
 */

function cookieOptions(path: string, maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path,
    maxAge: maxAgeSeconds * 1000,
  };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export function setAuthCookies(res: Response, { accessToken, refreshToken }: TokenPair): void {
  res.cookie(
    AUTH_COOKIES.access.name,
    accessToken,
    cookieOptions(AUTH_COOKIES.access.path, ACCESS_TOKEN_TTL_SECONDS),
  );
  res.cookie(
    AUTH_COOKIES.refresh.name,
    refreshToken,
    cookieOptions(AUTH_COOKIES.refresh.path, REFRESH_TOKEN_TTL_SECONDS),
  );
}

/** Clearing must repeat the original path, or the browser keeps the old cookie. */
export function clearAuthCookies(res: Response): void {
  res.clearCookie(AUTH_COOKIES.access.name, { path: AUTH_COOKIES.access.path });
  res.clearCookie(AUTH_COOKIES.refresh.name, { path: AUTH_COOKIES.refresh.path });
}
