import { DB_TRANSACTION_MAX_WAIT_MS, DB_TRANSACTION_TIMEOUT_MS, MONEY_DECIMAL_PLACES } from '../../config/constants.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { isRecordNotFound } from '../../lib/prisma-errors.js';
import { prisma } from '../../lib/prisma.js';
import { escapeLikePattern } from '../../lib/search.js';
import type {
  CreateTransactionInput,
  ListTransactionsQuery,
  UpdateTransactionInput,
} from './transactions.validation.js';

/** All business rules for `/transactions` (ARCHITECTURE.md §7). */

/** The row shape §7 publishes for a transaction. The dashboard borrows it rather than copying it. */
export const TRANSACTION_SELECT = {
  id: true,
  type: true,
  amount: true,
  description: true,
  date: true,
  createdAt: true,
  category: { select: { id: true, name: true } },
} as const;

type TransactionRow = Prisma.TransactionGetPayload<{ select: typeof TRANSACTION_SELECT }>;

export interface PublicTransaction {
  id: string;
  /** `"income" | "expense"` — the column is a plain String (ARCHITECTURE.md §5). */
  type: string;
  /** Serialized with exactly two decimals, as a string, so no float ever touches it (R-D2). */
  amount: string;
  description: string | null;
  date: Date;
  category: { id: string; name: string } | null;
  createdAt: Date;
}

/** Income and expense sums for the whole filter, not just the page on screen (§7). */
export interface TransactionTotals {
  income: string;
  expense: string;
}

export interface TransactionPage {
  items: PublicTransaction[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  totals: TransactionTotals;
}

const ZERO_AMOUNT = (0).toFixed(MONEY_DECIMAL_PLACES);

function notFound(): AppError {
  return new AppError('NOT_FOUND', 'Transaction not found.');
}

export function toPublicTransaction(row: TransactionRow): PublicTransaction {
  return { ...row, amount: row.amount.toFixed(MONEY_DECIMAL_PLACES) };
}

/**
 * A category the caller does not own reads as a missing category (R-A7); one that exists but
 * tracks the other direction is a validation failure, because the pairing is what is wrong.
 */
async function assertCategoryUsable(
  client: Prisma.TransactionClient,
  userId: string,
  categoryId: string,
  type: string,
): Promise<void> {
  const category = await client.category.findFirst({
    where: { id: categoryId, userId },
    select: { type: true },
  });

  if (!category) {
    throw new AppError('NOT_FOUND', 'Category not found.');
  }

  if (category.type !== type) {
    throw new AppError('VALIDATION_ERROR', `Choose a ${type} category for a ${type} transaction.`, [
      { field: 'categoryId', message: 'does not match the transaction type' },
    ]);
  }
}

/** Every filter in §7, all combinable, all inside the caller's own rows (R-B2, R-D4). */
function buildWhere(userId: string, query: ListTransactionsQuery): Prisma.TransactionWhereInput {
  const { search, type, categoryId, from, to, minAmount, maxAmount } = query;
  const where: Prisma.TransactionWhereInput = { userId };

  if (type !== undefined) {
    where.type = type;
  }

  if (categoryId !== undefined) {
    where.categoryId = categoryId;
  }

  if (from !== undefined || to !== undefined) {
    const date: Prisma.DateTimeFilter = {};
    if (from !== undefined) {
      date.gte = from;
    }
    if (to !== undefined) {
      date.lte = to;
    }
    where.date = date;
  }

  if (minAmount !== undefined || maxAmount !== undefined) {
    const amount: Prisma.DecimalFilter = {};
    if (minAmount !== undefined) {
      amount.gte = minAmount;
    }
    if (maxAmount !== undefined) {
      amount.lte = maxAmount;
    }
    where.amount = amount;
  }

  if (search !== undefined) {
    // Wildcards a person types must match literally (R-V5).
    where.description = { contains: escapeLikePattern(search), mode: 'insensitive' };
  }

  return where;
}

function buildOrderBy({
  sort,
  order,
}: ListTransactionsQuery): Prisma.TransactionOrderByWithRelationInput[] {
  // The id breaks ties so a row cannot appear on two pages, or on none.
  const tieBreaker: Prisma.TransactionOrderByWithRelationInput = { id: 'asc' };

  return sort === 'amount' ? [{ amount: order }, tieBreaker] : [{ date: order }, tieBreaker];
}

function readTotals(
  groups: Array<{ type: string; _sum: { amount: Prisma.Decimal | null } }>,
): TransactionTotals {
  const totals: TransactionTotals = { income: ZERO_AMOUNT, expense: ZERO_AMOUNT };

  for (const group of groups) {
    if (group.type === 'income' || group.type === 'expense') {
      totals[group.type] = group._sum.amount?.toFixed(MONEY_DECIMAL_PLACES) ?? ZERO_AMOUNT;
    }
  }

  return totals;
}

/**
 * The page, its row count, and the filter's totals are read in one batched transaction, so they
 * always describe the same data (R-D5). Sums come from `groupBy`, never from adding rows up in
 * JavaScript (R-D3, R-B3).
 */
export async function listTransactions(
  userId: string,
  query: ListTransactionsQuery,
): Promise<TransactionPage> {
  const { page, limit } = query;
  const where = buildWhere(userId, query);

  const [rows, total, groups] = await prisma.$transaction(
    [
      prisma.transaction.findMany({
        where,
        select: TRANSACTION_SELECT,
        orderBy: buildOrderBy(query),
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.transaction.count({ where }),
      prisma.transaction.groupBy({ by: ['type'], where, _sum: { amount: true } }),
    ],
    // Defaults (maxWait 2s) are too tight for a cold/pooled free-tier connection, where starting
    // the transaction alone can exceed 2s and 500 the read (see the constants for the rationale).
    { maxWait: DB_TRANSACTION_MAX_WAIT_MS, timeout: DB_TRANSACTION_TIMEOUT_MS },
  );

  return {
    items: rows.map(toPublicTransaction),
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    totals: readTotals(groups),
  };
}

export async function createTransaction(
  userId: string,
  input: CreateTransactionInput,
): Promise<PublicTransaction> {
  await assertCategoryUsable(prisma, userId, input.categoryId, input.type);

  const row = await prisma.transaction.create({
    data: {
      userId,
      type: input.type,
      amount: input.amount,
      categoryId: input.categoryId,
      description: input.description ?? null,
      date: input.date,
    },
    select: TRANSACTION_SELECT,
  });

  return toPublicTransaction(row);
}

export async function getTransaction(userId: string, id: string): Promise<PublicTransaction> {
  const row = await prisma.transaction.findFirst({
    where: { id, userId },
    select: TRANSACTION_SELECT,
  });

  if (!row) {
    throw notFound();
  }

  return toPublicTransaction(row);
}

/**
 * Read and write share one transaction because the category check depends on the row's current
 * state: changing only the type still has to leave the transaction paired with a category that
 * tracks the same direction.
 */
export async function updateTransaction(
  userId: string,
  id: string,
  input: UpdateTransactionInput,
): Promise<PublicTransaction> {
  return prisma.$transaction(async (tx) => {
    const current = await tx.transaction.findFirst({
      where: { id, userId },
      select: { type: true, categoryId: true },
    });

    if (!current) {
      throw notFound();
    }

    const nextCategoryId = input.categoryId ?? current.categoryId;
    const nextType = input.type ?? current.type;

    if (nextCategoryId !== null && (input.categoryId !== undefined || input.type !== undefined)) {
      await assertCategoryUsable(tx, userId, nextCategoryId, nextType);
    }

    const data: Prisma.TransactionUncheckedUpdateInput = {};

    if (input.type !== undefined) {
      data.type = input.type;
    }
    if (input.amount !== undefined) {
      data.amount = input.amount;
    }
    if (input.categoryId !== undefined) {
      data.categoryId = input.categoryId;
    }
    if (input.description !== undefined) {
      data.description = input.description;
    }
    if (input.date !== undefined) {
      data.date = input.date;
    }

    try {
      const row = await tx.transaction.update({ where: { id }, data, select: TRANSACTION_SELECT });

      return toPublicTransaction(row);
    } catch (error) {
      // Only reachable if the row disappeared between the read and the write.
      if (isRecordNotFound(error)) {
        throw notFound();
      }
      throw error;
    }
  });
}

/** `deleteMany` keeps `userId` in the filter, so a foreign id deletes nothing and 404s (R-D4). */
export async function deleteTransaction(userId: string, id: string): Promise<void> {
  const { count } = await prisma.transaction.deleteMany({ where: { id, userId } });

  if (count === 0) {
    throw notFound();
  }
}
