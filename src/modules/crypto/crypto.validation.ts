import { z } from 'zod';

/**
 * Request schemas for `/crypto` (ARCHITECTURE.md §7, R-V1). Both endpoints are read-only; the
 * caps keep an upstream query bounded (R-B8) and the coerced `page` mirrors the other list routes.
 */

/** A search term (name or symbol) is short by nature; the cap blunts oversized upstream queries. */
const searchTerm = z.string().trim().min(1).max(50);

export const listMarketsQuerySchema = z.object({
  search: searchTerm.optional(),
  page: z.coerce.number().int().min(1).max(10).default(1),
});

export const searchCoinsQuerySchema = z.object({
  q: searchTerm,
});

export type ListMarketsQuery = z.infer<typeof listMarketsQuerySchema>;
export type SearchCoinsQuery = z.infer<typeof searchCoinsQuerySchema>;
