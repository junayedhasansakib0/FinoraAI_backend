import { z } from 'zod';

import { TRANSACTION_TYPES } from '../../config/categories.js';
import {
  DESCRIPTION_MAX_LENGTH,
  FUTURE_DATE_TOLERANCE_MS,
  MONEY_MAX,
  MONEY_MIN,
  PAGE_DEFAULT,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
} from '../../config/constants.js';
import { idSchema } from '../../lib/schemas.js';

/** Request schemas for `/transactions` (ARCHITECTURE.md §7, R-V1–R-V5). */

const transactionType = z.enum(TRANSACTION_TYPES);

/** Nine digits and two decimals is the widest value §7 allows, and it fits `Decimal(14,2)`. */
const MONEY_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/;
const AMOUNT_MESSAGE = `must be between ${MONEY_MIN.toFixed(2)} and ${MONEY_MAX.toFixed(2)} with at most 2 decimal places`;

/**
 * Money arrives as a number or a numeric string and leaves as a canonical decimal string, so
 * Prisma hands Postgres an exact value and no float is ever involved (R-V2, R-D2). Shape and
 * range are one check: two would report the same message twice for a value that fails both.
 */
const moneyAmount = z
  .union([z.number(), z.string()])
  .transform((value) => (typeof value === 'number' ? String(value) : value.trim()))
  .refine(
    (value) =>
      MONEY_PATTERN.test(value) && Number(value) >= MONEY_MIN && Number(value) <= MONEY_MAX,
    AMOUNT_MESSAGE,
  );

const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** A time needs an explicit offset: without one, parsing would depend on the server's clock. */
const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_MESSAGE = 'must be an ISO-8601 date (YYYY-MM-DD) or a date and time with an offset';

/**
 * R-V3. A bare `YYYY-MM-DD` is anchored to UTC — midnight for a point in time or the start of a
 * range, the last millisecond of the day when it closes a range, so `to=2026-09-05` includes
 * everything booked on the 5th.
 */
function isoDate(endOfDay = false) {
  return z
    .string()
    .trim()
    .refine(
      (value) =>
        (ISO_DATE_ONLY.test(value) || ISO_DATE_TIME.test(value)) &&
        !Number.isNaN(Date.parse(value)),
      DATE_MESSAGE,
    )
    .transform((value) =>
      ISO_DATE_ONLY.test(value)
        ? new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`)
        : new Date(value),
    );
}

const transactionDate = isoDate().refine(
  (date) => date.getTime() <= Date.now() + FUTURE_DATE_TOLERANCE_MS,
  'cannot be more than one day in the future',
);

/** An empty description is stored as null rather than as an empty string. */
const description = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX_LENGTH)
  .transform((value) => (value.length === 0 ? null : value));

export const createTransactionSchema = z.object({
  type: transactionType,
  amount: moneyAmount,
  categoryId: idSchema,
  description: description.optional(),
  date: transactionDate,
});

/** Every field is editable; sending none would be a no-op write, so it is rejected. */
export const updateTransactionSchema = z
  .object({
    type: transactionType.optional(),
    amount: moneyAmount.optional(),
    categoryId: idSchema.optional(),
    description: description.optional(),
    date: transactionDate.optional(),
  })
  .refine(
    (values) => Object.values(values).some((value) => value !== undefined),
    'at least one field must be provided',
  );

export const listTransactionsQuerySchema = z
  .object({
    search: z
      .string()
      .trim()
      .max(DESCRIPTION_MAX_LENGTH)
      .optional()
      .transform((value) => (value === undefined || value.length === 0 ? undefined : value)),
    type: transactionType.optional(),
    categoryId: idSchema.optional(),
    from: isoDate().optional(),
    to: isoDate(true).optional(),
    minAmount: moneyAmount.optional(),
    maxAmount: moneyAmount.optional(),
    sort: z.enum(['date', 'amount']).default('date'),
    order: z.enum(['asc', 'desc']).default('desc'),
    page: z.coerce.number().int().min(1).default(PAGE_DEFAULT),
    limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  })
  .refine(({ from, to }) => from === undefined || to === undefined || from <= to, {
    message: 'must not be earlier than the start of the range',
    path: ['to'],
  })
  .refine(
    ({ minAmount, maxAmount }) =>
      minAmount === undefined || maxAmount === undefined || Number(minAmount) <= Number(maxAmount),
    { message: 'must not be lower than the minimum amount', path: ['maxAmount'] },
  );

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
