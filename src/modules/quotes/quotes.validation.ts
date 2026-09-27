import { z } from 'zod';

import {
  QUOTE_CATEGORIES,
  QUOTE_TEXT_MAX_CHARS,
  QUOTE_WORD_MAX,
  QUOTE_WORD_MIN,
} from './quotes.constants.js';

/**
 * Schemas for the quotes endpoint. `categoryParamSchema` validates untrusted client input — the
 * `:category` path segment (R-V1). `quoteOutputSchema` validates untrusted *model* output (R-I4):
 * the AI Service JSON-parses the reply, checks it here, and repairs or fails on a miss — the quotes
 * service then treats any failure as a reason to fall back, never to error the request.
 */

/** The `:category` path segment must be one of the three sections that carry the card. */
export const categoryParamSchema = z.object({
  category: z.enum(QUOTE_CATEGORIES),
});

/** Count words by whitespace runs, ignoring empty splits from leading/trailing spaces. */
function wordCount(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

/**
 * The shape a generated line must satisfy: a non-empty, character- and word-bounded string, plus an
 * optional echoed category (the service additionally checks it matches what was asked). The bounds
 * are the cap that keeps a runaway or hostile reply from reaching the client (R-I4/R-B8).
 */
export const quoteOutputSchema = z.object({
  quote: z
    .string()
    .trim()
    .min(1)
    .max(QUOTE_TEXT_MAX_CHARS)
    .refine((value) => {
      const words = wordCount(value);
      return words >= QUOTE_WORD_MIN && words <= QUOTE_WORD_MAX;
    }, `quote must be between ${String(QUOTE_WORD_MIN)} and ${String(QUOTE_WORD_MAX)} words`),
  category: z.enum(QUOTE_CATEGORIES).optional(),
});

export type CategoryParam = z.infer<typeof categoryParamSchema>;
export type QuoteOutput = z.infer<typeof quoteOutputSchema>;
