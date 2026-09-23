import { z } from 'zod';

import { idSchema } from '../../lib/schemas.js';

/** Request schemas for `/budgets` (ARCHITECTURE.md §7, R-V1–R-V2). */

const moneyAmount = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .refine(
    (value) => /^\d{1,9}(?:\.\d{1,2})?$/.test(value) && Number(value) >= 0.01 && Number(value) <= 999999999.99,
    'must be between 0.01 and 999999999.99 with at most 2 decimal places',
  );

export const listBudgetsQuerySchema = z.object({
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export const createBudgetSchema = z.object({
  amount: moneyAmount,
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(2000).max(2100),
  categoryId: idSchema.nullable().optional(),
});

export const updateBudgetSchema = z.object({
  amount: moneyAmount,
});

export type ListBudgetsQuery = z.infer<typeof listBudgetsQuerySchema>;
export type CreateBudgetInput = z.infer<typeof createBudgetSchema>;
export type UpdateBudgetInput = z.infer<typeof updateBudgetSchema>;