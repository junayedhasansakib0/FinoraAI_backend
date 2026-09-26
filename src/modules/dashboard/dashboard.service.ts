import {
  DASHBOARD_BREAKDOWN_LIMIT,
  DASHBOARD_RECENT_LIMIT,
  MONEY_DECIMAL_PLACES,
} from '../../config/constants.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { monthRange, monthWindow, type MonthRange } from '../../lib/month-range.js';
import { prisma } from '../../lib/prisma.js';
import {
  toPublicTransaction,
  TRANSACTION_SELECT,
  type PublicTransaction,
} from '../transactions/transactions.service.js';

/**
 * Every figure the dashboard shows is worked out here (ARCHITECTURE.md §7): the client formats
 * strings and draws bars, and never adds, subtracts or divides money itself (R-B3). Sums come
 * from `groupBy` and `aggregate`, so no transaction is ever loaded in order to be added up
 * (R-D3), and every `where` opens with `userId`, so one account cannot read another's totals
 * (R-B2, R-D4). Months are cut on the account holder's own calendar (D9, `lib/month-range.ts`).
 */

const NO_MONEY = new Prisma.Decimal(0);
const PERCENT_DECIMAL_PLACES = 1;

/** Income and expense as the database summed them, before anything is serialized. */
interface DirectionTotals {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
}

/** What `groupBy({ by: ['type'], _sum: { amount: true } })` answers with. */
interface TypeGroup {
  type: string;
  _sum: { amount: Prisma.Decimal | null };
}

export interface DashboardMonth {
  /** 1–12, as counted in `timezone`. */
  month: number;
  year: number;
  /** The zone the boundaries were cut in: the profile's, or UTC if that one is unusable. */
  timezone: string;
}

/** All-time sums and the balance they leave (§7). Every field is a two-decimal string (R-D2). */
export interface AllTimeTotals {
  income: string;
  expense: string;
  /** Income − expense, which is negative when someone has spent more than they earned. */
  balance: string;
}

export interface MonthTotals {
  income: string;
  expense: string;
  net: string;
}

/**
 * The overall budget for the current month. `amount` is null when none is set, which leaves
 * nothing to remain and nothing to be a percentage of. What was spent is `currentMonth.expense`
 * by definition, so it is not published twice under a second name.
 */
export interface BudgetSummary {
  amount: string | null;
  remaining: string | null;
  pctUsed: number | null;
}

/** `savedAmount` is §4.3's "total savings"; `progressPct` is null while there are no goals. */
export interface SavingsSummary {
  goalCount: number;
  targetAmount: string;
  savedAmount: string;
  progressPct: number | null;
}

export interface DashboardSummary {
  month: DashboardMonth;
  allTime: AllTimeTotals;
  currentMonth: MonthTotals;
  budget: BudgetSummary;
  savings: SavingsSummary;
  recentTransactions: PublicTransaction[];
}

export interface AnalyticsPoint {
  month: number;
  year: number;
  income: string;
  expense: string;
  /** That month on its own. */
  net: string;
  /** The running balance at the month's close, carrying everything from before the window. */
  balance: string;
}

export interface BreakdownSlice {
  /** Null for spending whose category has since been deleted (R-D7). */
  categoryId: string | null;
  name: string | null;
  total: string;
  /** Percentage of the month's expenses, to one decimal; null only when nothing was spent. */
  share: number | null;
}

export interface CategoryBreakdown {
  month: number;
  year: number;
  total: string;
  categories: BreakdownSlice[];
  /** Everything past the slices above, so the donut still adds up to `total` (R-B8). */
  other: { categoryCount: number; total: string };
}

export interface DashboardAnalytics {
  months: number;
  timezone: string;
  /** Oldest month first, always `months` long, ending with the current one. */
  series: AnalyticsPoint[];
  breakdown: CategoryBreakdown;
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(MONEY_DECIMAL_PLACES);
}

/** A share of something rather than an amount of money, so it travels as a number. */
function percent(part: Prisma.Decimal, whole: Prisma.Decimal): number | null {
  if (whole.isZero()) {
    return null;
  }

  return part.dividedBy(whole).times(100).toDecimalPlaces(PERCENT_DECIMAL_PLACES).toNumber();
}

function sumsByType(groups: TypeGroup[]): DirectionTotals {
  const totals: DirectionTotals = { income: NO_MONEY, expense: NO_MONEY };

  for (const group of groups) {
    if (group.type === 'income' || group.type === 'expense') {
      totals[group.type] = group._sum.amount ?? NO_MONEY;
    }
  }

  return totals;
}

/**
 * Month boundaries follow the account holder's own timezone (D9), so the profile is read before
 * any aggregate can be shaped. A token whose user row has gone is a session that cannot be
 * honoured — 401 rather than a 500 from the arithmetic that would follow.
 */
async function readTimeZone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } });

  if (!user) {
    throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  }

  return user.timezone;
}

/**
 * `now` is a parameter rather than a call to `Date.now()` inside the query so a test can freeze
 * the month it lands in (R-T6).
 */
export async function readSummary(userId: string, now = new Date()): Promise<DashboardSummary> {
  const range = monthRange(now, await readTimeZone(userId));
  const inMonth = { userId, date: { gte: range.start, lt: range.end } };

  // One batch, so every figure on the dashboard describes the same moment (R-D5).
  const [allTimeGroups, monthGroups, budgetRow, goals, recent] = await prisma.$transaction([
    prisma.transaction.groupBy({ by: ['type'], where: { userId }, _sum: { amount: true } }),
    prisma.transaction.groupBy({ by: ['type'], where: inMonth, _sum: { amount: true } }),
    prisma.budget.findFirst({
      // `categoryId: null` is the overall budget; per-category rows are Phase 6's business.
      where: { userId, categoryId: null, month: range.month, year: range.year },
      select: { amount: true },
    }),
    prisma.savingsGoal.aggregate({
      where: { userId },
      _sum: { targetAmount: true, currentAmount: true },
      _count: { _all: true },
    }),
    prisma.transaction.findMany({
      where: { userId },
      select: TRANSACTION_SELECT,
      orderBy: [{ date: 'desc' }, { id: 'asc' }],
      take: DASHBOARD_RECENT_LIMIT,
    }),
  ]);

  const allTime = sumsByType(allTimeGroups);
  const month = sumsByType(monthGroups);
  const budget = budgetRow?.amount ?? null;
  const target = goals._sum.targetAmount ?? NO_MONEY;
  const saved = goals._sum.currentAmount ?? NO_MONEY;

  return {
    month: { month: range.month, year: range.year, timezone: range.timeZone },
    allTime: {
      income: money(allTime.income),
      expense: money(allTime.expense),
      balance: money(allTime.income.minus(allTime.expense)),
    },
    currentMonth: {
      income: money(month.income),
      expense: money(month.expense),
      net: money(month.income.minus(month.expense)),
    },
    budget: {
      amount: budget === null ? null : money(budget),
      remaining: budget === null ? null : money(budget.minus(month.expense)),
      pctUsed: budget === null ? null : percent(month.expense, budget),
    },
    savings: {
      goalCount: goals._count._all,
      targetAmount: money(target),
      savedAmount: money(saved),
      progressPct: percent(saved, target),
    },
    recentTransactions: recent.map(toPublicTransaction),
  };
}

/**
 * A `groupBy` cannot carry a joined name, and only the handful of slices that survive the cap
 * need one, so the names are read afterwards — still inside the caller's own rows.
 */
async function readCategoryNames(userId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) {
    return new Map();
  }

  const rows = await prisma.category.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, name: true },
  });

  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Where this month's money went. The database sums each category; ordering and capping happen
 * here, over one row per category rather than over transactions (R-D3). Both the total and the
 * remainder come from that single answer, so the slices always add up to the month's spending
 * even for someone who keeps more categories than a donut can show.
 */
async function readBreakdown(userId: string, range: MonthRange): Promise<CategoryBreakdown> {
  const groups = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: { userId, type: 'expense', date: { gte: range.start, lt: range.end } },
    _sum: { amount: true },
  });

  const ranked = groups
    .map((group) => ({ categoryId: group.categoryId, total: group._sum.amount ?? NO_MONEY }))
    .sort((left, right) => {
      const byAmount = right.total.comparedTo(left.total);

      if (byAmount !== 0) {
        return byAmount;
      }

      // Two equal sums still have to come back in the same order on every request.
      return (left.categoryId ?? '') < (right.categoryId ?? '') ? -1 : 1;
    });

  const total = ranked.reduce((sum, slice) => sum.plus(slice.total), NO_MONEY);
  const top = ranked.slice(0, DASHBOARD_BREAKDOWN_LIMIT);
  const rest = ranked.slice(DASHBOARD_BREAKDOWN_LIMIT);
  const names = await readCategoryNames(
    userId,
    top.map((slice) => slice.categoryId).filter((id): id is string => id !== null),
  );

  return {
    month: range.month,
    year: range.year,
    total: money(total),
    categories: top.map((slice) => ({
      categoryId: slice.categoryId,
      name: slice.categoryId === null ? null : (names.get(slice.categoryId) ?? null),
      total: money(slice.total),
      share: percent(slice.total, total),
    })),
    other: {
      categoryCount: rest.length,
      total: money(rest.reduce((sum, slice) => sum.plus(slice.total), NO_MONEY)),
    },
  };
}

/**
 * The series and the breakdown are read in two separate calls, not one batch: the months belong
 * together in a single `$transaction`, because a running balance assembled from different moments
 * would be visibly wrong, while the breakdown is a single query and consistent on its own. Kept
 * apart this way they have no data dependency on each other, so they are issued concurrently.
 */
export async function readAnalytics(
  userId: string,
  months: number,
  now = new Date(),
): Promise<DashboardAnalytics> {
  const timeZone = await readTimeZone(userId);
  const current = monthRange(now, timeZone);
  const window = monthWindow(now, timeZone, months);
  // The schema floors `months` at 1, where the window is the current month alone.
  const [earliest = current] = window;

  // The series batch and the breakdown read from different rows and never share a figure, so they
  // run at the same time rather than one after the other — one fewer serial round trip to the
  // high-latency free-tier DB, with no effect on either result. The months still travel together
  // inside `$transaction` so the running balance stays internally consistent (R-D5).
  const [groups, breakdown] = await Promise.all([
    prisma.$transaction([
      // Everything before the window, so the balance line starts where the ledger actually stands.
      prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, date: { lt: earliest.start } },
        _sum: { amount: true },
      }),
      ...window.map((range) =>
        prisma.transaction.groupBy({
          by: ['type'],
          where: { userId, date: { gte: range.start, lt: range.end } },
          _sum: { amount: true },
        }),
      ),
    ]),
    readBreakdown(userId, current),
  ]);

  const [openingGroups = [], ...monthlyGroups] = groups;
  const opening = sumsByType(openingGroups);
  let running = opening.income.minus(opening.expense);
  const series: AnalyticsPoint[] = [];

  for (const [index, range] of window.entries()) {
    const totals = sumsByType(monthlyGroups[index] ?? []);

    running = running.plus(totals.income).minus(totals.expense);

    series.push({
      month: range.month,
      year: range.year,
      income: money(totals.income),
      expense: money(totals.expense),
      net: money(totals.income.minus(totals.expense)),
      balance: money(running),
    });
  }

  return {
    months,
    timezone: current.timeZone,
    series,
    breakdown,
  };
}
