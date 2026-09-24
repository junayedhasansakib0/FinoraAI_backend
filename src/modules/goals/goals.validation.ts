import { z } from 'zod';

import { MONEY_MAX, MONEY_MIN, NAME_MAX_LENGTH } from '../../config/constants.js';

/** Request schemas for `/savings-goals` (ARCHITECTURE.md §7, R-V1–R-V3). */

/** Nine digits and two decimals is the widest value §7 allows, and it fits `Decimal(14,2)`. */
const MONEY_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/;

/**
 * Money arrives as a number or a numeric string and leaves as a canonical decimal string, so
 * Prisma hands Postgres an exact value and no float is ever involved (R-V2, R-D2). `min` differs
 * per field — the shared floor is a cent, but a goal's target is at least one whole unit (§7).
 */
function money(min: number, message: string) {
  return z
    .union([z.number(), z.string()])
    .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
    .refine(
      (value) => MONEY_PATTERN.test(value) && Number(value) >= min && Number(value) <= MONEY_MAX,
      message,
    );
}

const targetAmount = money(
  1,
  `must be between 1.00 and ${MONEY_MAX.toFixed(2)} with at most 2 decimal places`,
);

const currentAmount = money(
  MONEY_MIN,
  `must be between ${MONEY_MIN.toFixed(2)} and ${MONEY_MAX.toFixed(2)} with at most 2 decimal places`,
);

const name = z.string().trim().min(1, 'is required').max(NAME_MAX_LENGTH);

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A time needs an explicit offset: without one, parsing would depend on the server's clock. */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_MESSAGE = 'must be an ISO-8601 date (YYYY-MM-DD) or a date and time with an offset';

/**
 * A goal deadline (R-V3). A bare `YYYY-MM-DD` closes at the last millisecond of that day in UTC,
 * so a person has the whole named day to reach the goal, and `must be in the future` still holds
 * against the current instant.
 */
const deadline = z
  .string()
  .trim()
  .refine(
    (value) =>
      (ISO_DATE_ONLY.test(value) || ISO_DATE_TIME.test(value)) && !Number.isNaN(Date.parse(value)),
    DATE_MESSAGE,
  )
  .transform((value) =>
    ISO_DATE_ONLY.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value),
  )
  .refine((date) => date.getTime() > Date.now(), 'must be in the future');

export const createSavingsGoalSchema = z.object({
  name,
  targetAmount,
  currentAmount: currentAmount.optional(),
  deadline,
});

/** Every field is editable; sending none would be a no-op write, so it is rejected. */
export const updateSavingsGoalSchema = z
  .object({
    name: name.optional(),
    targetAmount: targetAmount.optional(),
    currentAmount: currentAmount.optional(),
    deadline: deadline.optional(),
  })
  .refine(
    (values) => Object.values(values).some((value) => value !== undefined),
    'at least one field must be provided',
  );

export type CreateSavingsGoalInput = z.infer<typeof createSavingsGoalSchema>;
export type UpdateSavingsGoalInput = z.infer<typeof updateSavingsGoalSchema>;
