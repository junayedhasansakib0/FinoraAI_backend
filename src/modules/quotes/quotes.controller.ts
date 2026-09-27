import type { Request, Response } from 'express';

import { sendSuccess } from '../../lib/api-response.js';

import type { QuoteCategory } from './quotes.constants.js';
import { getQuote } from './quotes.service.js';

/**
 * Transport layer for `/quotes` (ARCHITECTURE.md §7). Thin by rule (R-B1): the category has already
 * been validated to the enum by `validateParams`, so the controller just hands it to the service and
 * returns the `{ quote, category, source, disclaimer }` envelope. The service never throws for a
 * generation problem — it returns a fallback line — so this endpoint answers 200 in every case a
 * valid category reaches it.
 */
export function quote(req: Request, res: Response): void {
  const { category } = req.params as { category: QuoteCategory };
  sendSuccess(res, 200, getQuote(category));
}
