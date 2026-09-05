import { z } from 'zod';

import { TRANSACTION_TYPES } from '../../config/categories.js';
import { NAME_MAX_LENGTH } from '../../config/constants.js';

/** Request schemas for `/categories` (ARCHITECTURE.md §7). */

/** Names are stored as typed, minus surrounding space, and capped at 60 chars (R-V4). */
const categoryName = z.string().trim().min(1, 'is required').max(NAME_MAX_LENGTH);

const categoryType = z.enum(TRANSACTION_TYPES);

export const listCategoriesQuerySchema = z.object({
  type: categoryType.optional(),
});

export const createCategorySchema = z.object({
  name: categoryName,
  type: categoryType,
});

/** Only the name is editable: moving a category between types would rewrite its history. */
export const updateCategorySchema = z.object({
  name: categoryName,
});

export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
