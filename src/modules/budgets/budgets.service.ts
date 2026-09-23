import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { monthRange, rangeFor } from '../../lib/month-range.js';
import { prisma } from '../../lib/prisma.js';
import type { CreateBudgetInput, ListBudgetsQuery, UpdateBudgetInput } from './budgets.validation.js';

/**
 * All business rules for `/budgets` (ARCHITECTURE.md §7, R-B3, R-D3, R-D6).
 * Financial math is always executed server-side.
 */

const STATUS_OK_THRESHOLD = 80;
const STATUS_WARN_THRESHOLD = 100;

export type BudgetStatus = 'ok' | 'warning' | 'exceeded';

export interface PublicBudget {
  id: string;
  categoryId: string | null;
  amount: string;
  month: number;
  year: number;
  spent: string;
  remaining: string;
  pctUsed: number | null;
  status: BudgetStatus;
  categoryName: string | null;
}

export function computeStatus(pctUsed: number): BudgetStatus {
  if (pctUsed < STATUS_OK_THRESHOLD) return 'ok';
  if (pctUsed <= STATUS_WARN_THRESHOLD) return 'warning';
  return 'exceeded';
}

export function computePctUsed(spent: Prisma.Decimal, budgetAmount: Prisma.Decimal): number | null {
  if (budgetAmount.isZero()) return null;
  return spent.dividedBy(budgetAmount).times(100).toDecimalPlaces(2).toNumber();
}

async function readTimeZone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });

  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  }

  return user.timezone;
}

/** Helper to compute spent, remaining, pctUsed, and status for a budget row. */
async function computeBudgetFigures(
  userId: string,
  budget: {
    id: string;
    categoryId: string | null;
    amount: Prisma.Decimal;
    month: number;
    year: number;
    category?: { name: string; type?: string } | null;
  },
  timeZone: string,
): Promise<PublicBudget> {
  const range = rangeFor(budget.year, budget.month, timeZone);
  const inMonth = {
    userId,
    type: 'expense',
    date: { gte: range.start, lt: range.end },
  };

  let spent = new Prisma.Decimal(0);

  if (budget.categoryId === null) {
    const agg = await prisma.transaction.aggregate({
      where: inMonth,
      _sum: { amount: true },
    });
    if (agg._sum.amount) {
      spent = agg._sum.amount;
    }
  } else {
    const agg = await prisma.transaction.aggregate({
      where: { ...inMonth, categoryId: budget.categoryId },
      _sum: { amount: true },
    });
    if (agg._sum.amount) {
      spent = agg._sum.amount;
    }
  }

  const pctUsed = computePctUsed(spent, budget.amount);
  const status = pctUsed !== null ? computeStatus(pctUsed) : 'ok';
  const remaining = budget.amount.minus(spent);

  return {
    id: budget.id,
    categoryId: budget.categoryId,
    amount: budget.amount.toFixed(2),
    month: budget.month,
    year: budget.year,
    spent: spent.toFixed(2),
    remaining: remaining.toFixed(2),
    pctUsed,
    status,
    categoryName: budget.category?.name ?? null,
  };
}

/** List budgets for the authenticated user, scoped to month/year. */
export async function listBudgets(
  userId: string,
  query: ListBudgetsQuery,
  now = new Date(),
): Promise<PublicBudget[]> {
  const timeZone = await readTimeZone(userId);
  let targetMonth = query.month;
  let targetYear = query.year;

  if (targetMonth === undefined || targetYear === undefined) {
    const current = monthRange(now, timeZone);
    targetMonth = targetMonth ?? current.month;
    targetYear = targetYear ?? current.year;
  }

  const range = rangeFor(targetYear, targetMonth, timeZone);
  const inMonth = {
    userId,
    type: 'expense',
    date: { gte: range.start, lt: range.end },
  };

  const [budgets, expenseGroups, overallAgg] = await Promise.all([
    prisma.budget.findMany({
      where: { userId, month: targetMonth, year: targetYear },
      include: { category: { select: { name: true, type: true } } },
      orderBy: [{ categoryId: 'asc' }, { id: 'asc' }],
    }),
    prisma.transaction.groupBy({
      by: ['categoryId'],
      where: inMonth,
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: inMonth,
      _sum: { amount: true },
    }),
  ]);

  const categoryExpenseMap = new Map<string, Prisma.Decimal>();
  for (const group of expenseGroups) {
    if (group.categoryId && group._sum.amount) {
      categoryExpenseMap.set(group.categoryId, group._sum.amount);
    }
  }

  const overallSpent = overallAgg._sum.amount ?? new Prisma.Decimal(0);

  return budgets.map((budget) => {
    const spent =
      budget.categoryId === null
        ? overallSpent
        : (categoryExpenseMap.get(budget.categoryId) ?? new Prisma.Decimal(0));

    const pctUsed = computePctUsed(spent, budget.amount);
    const status = pctUsed !== null ? computeStatus(pctUsed) : 'ok';
    const remaining = budget.amount.minus(spent);

    return {
      id: budget.id,
      categoryId: budget.categoryId,
      amount: budget.amount.toFixed(2),
      month: budget.month,
      year: budget.year,
      spent: spent.toFixed(2),
      remaining: remaining.toFixed(2),
      pctUsed,
      status,
      categoryName: budget.category?.name ?? null,
    };
  });
}

/** Create a new budget for the user. */
export async function createBudget(
  userId: string,
  input: CreateBudgetInput,
): Promise<PublicBudget> {
  const { amount, month, year, categoryId } = input;
  const timeZone = await readTimeZone(userId);

  if (categoryId !== null && categoryId !== undefined) {
    const category = await prisma.category.findFirst({
      where: { id: categoryId, userId },
      select: { id: true, name: true, type: true },
    });
    if (!category) {
      throw new AppError('NOT_FOUND', 'Category not found.');
    }
    if (category.type !== 'expense') {
      throw new AppError('VALIDATION_ERROR', 'Budgets can only be created for expense categories.');
    }
  }

  const existing = await prisma.budget.findFirst({
    where: {
      userId,
      month,
      year,
      categoryId: categoryId ?? null,
    },
  });

  if (existing) {
    throw new AppError('CONFLICT', 'A budget with this scope already exists for this month.');
  }

  const budgetRow = await prisma.budget.create({
    data: {
      userId,
      amount: new Prisma.Decimal(amount),
      month,
      year,
      categoryId: categoryId ?? null,
    },
    include: {
      category: { select: { name: true, type: true } },
    },
  });

  return computeBudgetFigures(userId, budgetRow, timeZone);
}

/** Update a budget's amount. */
export async function updateBudget(
  userId: string,
  id: string,
  input: UpdateBudgetInput,
): Promise<PublicBudget> {
  const timeZone = await readTimeZone(userId);
  const budget = await prisma.budget.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!budget) {
    throw new AppError('NOT_FOUND', 'Budget not found.');
  }

  const updated = await prisma.budget.update({
    where: { id },
    data: { amount: new Prisma.Decimal(input.amount) },
    include: {
      category: { select: { name: true, type: true } },
    },
  });

  return computeBudgetFigures(userId, updated, timeZone);
}

/** Delete a budget. */
export async function deleteBudget(userId: string, id: string): Promise<void> {
  const budget = await prisma.budget.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!budget) {
    throw new AppError('NOT_FOUND', 'Budget not found.');
  }

  await prisma.budget.delete({ where: { id } });
}