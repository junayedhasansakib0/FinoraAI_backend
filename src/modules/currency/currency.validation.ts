import { z } from 'zod';

/**
 * Request schemas for `/currency` (ARCHITECTURE.md §7, R-V1). Codes are validated for shape here —
 * a non-three-letter code is a 400 before any upstream call — while whether a well-formed code is
 * actually supported is checked in the service against Frankfurter's currency list.
 */

/** A three-letter currency code, upper-cased so `usd` and `USD` resolve to the same cache entry. */
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a three-letter currency code');

/** A converter amount: positive, finite, and bounded so an upstream query never runs away (R-B8). */
const amount = z.coerce.number().positive().finite().max(1_000_000_000_000);

export const ratesQuerySchema = z.object({
  base: currencyCode.default('USD'),
  /** Optional comma-separated list; split and validated per-code in the service. */
  symbols: z.string().trim().optional(),
});

export const convertQuerySchema = z.object({
  from: currencyCode,
  to: currencyCode,
  amount,
});

export type RatesQuery = z.infer<typeof ratesQuerySchema>;
export type ConvertQuery = z.infer<typeof convertQuerySchema>;
