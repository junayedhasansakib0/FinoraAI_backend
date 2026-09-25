import {
  AI_AVERAGE_MONTHS,
  AI_QA_MONTHS,
  AI_SPENDING_MONTHS,
  AI_TOP_CATEGORIES,
} from '../../config/constants.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { monthWindow, rangeFor, type MonthRange } from '../../lib/month-range.js';
import { prisma } from '../../lib/prisma.js';

/**
 * The Financial Analysis Service (ARCHITECTURE.md §8): the ONLY place the AI feature reaches
 * Prisma (R-I1). It turns a user's ledger into small, aggregate-only payloads — month totals,
 * top ≤8 categories with shares, month-over-month deltas, budget usage, goal progress — and
 * never lets a raw transaction, description, email or amount-by-amount list leave (D7, R-I1).
 * Every `where` opens with `userId`, so one account's numbers can never inform another's report
 * (R-B2, R-D4). Months are cut on the account holder's own calendar (D9, `lib/month-range.ts`).
 * Returning `null` means "not enough of this user's data to report on" — the caller answers 422.
 */

const NO_MONEY = new Prisma.Decimal(0);
const MONEY_DP = 2;
const PERCENT_DP = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const PROGRESS_CEILING = 100;
const UNCATEGORIZED = 'Uncategorized';
const OVERALL = 'Overall';

/** A single month's totals, every figure a two-decimal string (R-D2). */
export interface MonthPoint {
  month: number;
  year: number;
  income: string;
  expense: string;
  net: string;
}

/** One category's spend and its share of the window, to one decimal; null share when nothing was spent. */
export interface CategoryTotal {
  name: string;
  total: string;
  share: number | null;
}

/** A category's average monthly spend across the analysed window. */
export interface CategoryAverage {
  name: string;
  avgPerMonth: string;
}

/** One budget for a month set against what was actually spent; pctUsed null when the cap is zero. */
export interface BudgetUsage {
  category: string;
  amount: string;
  spent: string;
  pctUsed: number | null;
}

/** A savings goal's standing: capped progress, remaining amount, and days left to the deadline. */
export interface GoalProgress {
  name: string;
  target: string;
  saved: string;
  progressPct: number;
  remaining: string;
  deadline: string;
  daysRemaining: number;
}

interface DirectionTotals {
  income: Prisma.Decimal;
  expense: Prisma.Decimal;
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(MONEY_DP);
}

/** `part` as a percentage of `whole`, one decimal; null when there is no whole to divide by. */
function percent(part: Prisma.Decimal, whole: Prisma.Decimal): number | null {
  if (whole.isZero()) return null;
  return part.dividedBy(whole).times(100).toDecimalPlaces(PERCENT_DP).toNumber();
}

/** Signed percentage change from `prev` to `curr`; null when there is no baseline to compare to. */
function changePct(prev: Prisma.Decimal, curr: Prisma.Decimal): number | null {
  if (prev.isZero()) return null;
  return curr.minus(prev).dividedBy(prev.abs()).times(100).toDecimalPlaces(PERCENT_DP).toNumber();
}

/** Fold a `groupBy(['type'])` result down to income/expense sums, defaulting the absent side to zero. */
function sumsByType(groups: { type: string; _sum: { amount: Prisma.Decimal | null } }[]): DirectionTotals {
  const totals: DirectionTotals = { income: NO_MONEY, expense: NO_MONEY };
  for (const group of groups) {
    if (group.type === 'income') totals.income = group._sum.amount ?? NO_MONEY;
    else if (group.type === 'expense') totals.expense = group._sum.amount ?? NO_MONEY;
  }
  return totals;
}

interface UserContext {
  timeZone: string;
  currency: string;
}

/** The account holder's base currency and calendar. Absent user ⇒ the session outlived the account. */
async function readUserContext(userId: string): Promise<UserContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, currency: true },
  });
  if (!user) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
  return { timeZone: user.timezone, currency: user.currency };
}

/** Resolve category ids to names in one scoped query; ids not owned by the user simply drop out. */
async function readCategoryNames(userId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.category.findMany({
    where: { userId, id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Expense per category over [start, end), ranked, capped at the top few with shares and names. */
async function topExpenseCategories(
  userId: string,
  start: Date,
  end: Date,
): Promise<{ list: CategoryTotal[]; total: Prisma.Decimal }> {
  const groups = await prisma.transaction.groupBy({
    by: ['categoryId'],
    where: { userId, type: 'expense', date: { gte: start, lt: end } },
    _sum: { amount: true },
  });
  const ranked = groups
    .map((group) => ({ categoryId: group.categoryId, total: group._sum.amount ?? NO_MONEY }))
    .sort((a, b) => {
      const byTotal = b.total.comparedTo(a.total);
      return byTotal !== 0 ? byTotal : (a.categoryId ?? '').localeCompare(b.categoryId ?? '');
    });
  const total = ranked.reduce((sum, row) => sum.plus(row.total), NO_MONEY);
  const top = ranked.slice(0, AI_TOP_CATEGORIES);
  const names = await readCategoryNames(
    userId,
    top.map((row) => row.categoryId).filter((id): id is string => id !== null),
  );
  const list = top.map((row) => ({
    name: row.categoryId === null ? UNCATEGORIZED : names.get(row.categoryId) ?? UNCATEGORIZED,
    total: money(row.total),
    share: percent(row.total, total),
  }));
  return { list, total };
}

/** Per-month income/expense/net across a window, one scoped `groupBy` per month in one transaction. */
async function monthSeries(userId: string, window: MonthRange[]): Promise<MonthPoint[]> {
  const perMonth = await prisma.$transaction(
    window.map((range) =>
      prisma.transaction.groupBy({
        by: ['type'],
        where: { userId, date: { gte: range.start, lt: range.end } },
        _sum: { amount: true },
      }),
    ),
  );
  return window.map((range, index) => {
    const totals = sumsByType(perMonth[index] ?? []);
    return {
      month: range.month,
      year: range.year,
      income: money(totals.income),
      expense: money(totals.expense),
      net: money(totals.income.minus(totals.expense)),
    };
  });
}

/**
 * A month's budgets set against that month's spend: per-category caps against category spend, and
 * an `Overall` cap (categoryId null) against every expense in the month. Aggregates only, never rows.
 */
async function readBudgetUsage(userId: string, range: MonthRange): Promise<BudgetUsage[]> {
  const [budgets, catGroups, overall] = await Promise.all([
    prisma.budget.findMany({
      where: { userId, month: range.month, year: range.year },
      include: { category: { select: { name: true } } },
    }),
    prisma.transaction.groupBy({
      by: ['categoryId'],
      where: { userId, type: 'expense', date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    }),
    prisma.transaction.aggregate({
      where: { userId, type: 'expense', date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    }),
  ]);
  const spentByCategory = new Map<string, Prisma.Decimal>();
  for (const group of catGroups) {
    if (group.categoryId !== null) spentByCategory.set(group.categoryId, group._sum.amount ?? NO_MONEY);
  }
  const overallSpent = overall._sum.amount ?? NO_MONEY;
  return budgets.map((budget) => {
    const spent =
      budget.categoryId === null ? overallSpent : spentByCategory.get(budget.categoryId) ?? NO_MONEY;
    return {
      category: budget.categoryId === null ? OVERALL : budget.category?.name ?? UNCATEGORIZED,
      amount: money(budget.amount),
      spent: money(spent),
      pctUsed: percent(spent, budget.amount),
    };
  });
}

/** Each goal's standing as of `now`: progress capped at 100%, remaining floored at zero, days left. */
async function readGoals(userId: string, now: Date): Promise<GoalProgress[]> {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: AI_TOP_CATEGORIES,
  });
  return goals.map((goal) => {
    const rawPct = goal.targetAmount.isZero()
      ? 0
      : goal.currentAmount.dividedBy(goal.targetAmount).times(100).toDecimalPlaces(PERCENT_DP).toNumber();
    const remaining = Prisma.Decimal.max(goal.targetAmount.minus(goal.currentAmount), NO_MONEY);
    const daysRemaining = Math.max(0, Math.ceil((goal.deadline.getTime() - now.getTime()) / MS_PER_DAY));
    return {
      name: goal.name,
      target: money(goal.targetAmount),
      saved: money(goal.currentAmount),
      progressPct: Math.min(rawPct, PROGRESS_CEILING),
      remaining: money(remaining),
      deadline: goal.deadline.toISOString(),
      daysRemaining,
    };
  });
}

/** Context for the spending-analysis report: six months of totals, the window's top spend, MoM. */
export interface SpendingAnalysisContext {
  currency: string;
  monthsAnalyzed: number;
  months: MonthPoint[];
  topCategories: CategoryTotal[];
  /** Expense change from the previous month to the current one; null with no prior month to compare. */
  momExpenseChangePct: number | null;
  budgetUsage: BudgetUsage[];
}

/** Build the spending-analysis context, or null when the window holds no spending to analyse (422). */
export async function readSpendingAnalysis(
  userId: string,
  now = new Date(),
): Promise<SpendingAnalysisContext | null> {
  const { timeZone, currency } = await readUserContext(userId);
  const window = monthWindow(now, timeZone, AI_SPENDING_MONTHS);
  const earliest = window[0];
  const current = window[window.length - 1];
  if (!earliest || !current) return null;

  const months = await monthSeries(userId, window);
  const { list: topCategories, total: windowExpense } = await topExpenseCategories(
    userId,
    earliest.start,
    current.end,
  );
  if (windowExpense.isZero()) return null;

  const currentMonth = months[months.length - 1];
  const priorMonth = months[months.length - 2];
  const momExpenseChangePct =
    currentMonth && priorMonth
      ? changePct(new Prisma.Decimal(priorMonth.expense), new Prisma.Decimal(currentMonth.expense))
      : null;
  const budgetUsage = await readBudgetUsage(userId, current);

  return { currency, monthsAnalyzed: AI_SPENDING_MONTHS, months, topCategories, momExpenseChangePct, budgetUsage };
}

/** Context for the monthly-summary report: one month's totals and top spend against the month before. */
export interface MonthlySummaryContext {
  currency: string;
  month: number;
  year: number;
  income: string;
  expense: string;
  net: string;
  topCategories: CategoryTotal[];
  previousMonth: { income: string; expense: string; net: string } | null;
  /** Net change from the previous month to this one; null when there is no prior month recorded. */
  momNetChangePct: number | null;
}

/** Build the summary for one month, or null when that month has no transactions of the user's (422). */
export async function readMonthlySummary(
  userId: string,
  month: number,
  year: number,
): Promise<MonthlySummaryContext | null> {
  const { timeZone, currency } = await readUserContext(userId);
  const range = rangeFor(year, month, timeZone);
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevRange = rangeFor(prevYear, prevMonth, timeZone);

  const [thisGroups, prevGroups] = await prisma.$transaction([
    prisma.transaction.groupBy({
      by: ['type'],
      where: { userId, date: { gte: range.start, lt: range.end } },
      _sum: { amount: true },
    }),
    prisma.transaction.groupBy({
      by: ['type'],
      where: { userId, date: { gte: prevRange.start, lt: prevRange.end } },
      _sum: { amount: true },
    }),
  ]);
  if (thisGroups.length === 0) return null;

  const cur = sumsByType(thisGroups);
  const { list: topCategories } = await topExpenseCategories(userId, range.start, range.end);
  const prev = sumsByType(prevGroups);
  const previousMonth =
    prevGroups.length === 0
      ? null
      : { income: money(prev.income), expense: money(prev.expense), net: money(prev.income.minus(prev.expense)) };
  const momNetChangePct = previousMonth
    ? changePct(prev.income.minus(prev.expense), cur.income.minus(cur.expense))
    : null;

  return {
    currency,
    month,
    year,
    income: money(cur.income),
    expense: money(cur.expense),
    net: money(cur.income.minus(cur.expense)),
    topCategories,
    previousMonth,
    momNetChangePct,
  };
}

/** Context for savings recommendations: three-month averages plus every goal's standing. */
export interface SavingsContext {
  currency: string;
  monthsAnalyzed: number;
  avgMonthlyIncome: string;
  avgMonthlyExpense: string;
  avgSpendByCategory: CategoryAverage[];
  goals: GoalProgress[];
}

/** Build the savings context, or null when the window holds no income or spending to reason from (422). */
export async function readSavings(userId: string, now = new Date()): Promise<SavingsContext | null> {
  const { timeZone, currency } = await readUserContext(userId);
  const window = monthWindow(now, timeZone, AI_AVERAGE_MONTHS);
  const earliest = window[0];
  const current = window[window.length - 1];
  if (!earliest || !current) return null;

  const months = await monthSeries(userId, window);
  const totalIncome = months.reduce((sum, m) => sum.plus(new Prisma.Decimal(m.income)), NO_MONEY);
  const totalExpense = months.reduce((sum, m) => sum.plus(new Prisma.Decimal(m.expense)), NO_MONEY);
  const { list } = await topExpenseCategories(userId, earliest.start, current.end);
  const goals = await readGoals(userId, now);
  if (totalIncome.isZero() && totalExpense.isZero()) return null;

  const divisor = new Prisma.Decimal(AI_AVERAGE_MONTHS);
  const avgSpendByCategory = list.map((category) => ({
    name: category.name,
    avgPerMonth: money(new Prisma.Decimal(category.total).dividedBy(divisor)),
  }));

  return {
    currency,
    monthsAnalyzed: AI_AVERAGE_MONTHS,
    avgMonthlyIncome: money(totalIncome.dividedBy(divisor)),
    avgMonthlyExpense: money(totalExpense.dividedBy(divisor)),
    avgSpendByCategory,
    goals,
  };
}

/** Context for budget recommendations: three-month category averages against the current caps. */
export interface BudgetRecommendationsContext {
  currency: string;
  monthsAnalyzed: number;
  avgMonthlyExpense: string;
  categoryAverages: CategoryAverage[];
  currentBudgets: BudgetUsage[];
}

/** Build the budget-recommendations context, or null when the window holds no spending to base caps on (422). */
export async function readBudgetRecommendations(
  userId: string,
  now = new Date(),
): Promise<BudgetRecommendationsContext | null> {
  const { timeZone, currency } = await readUserContext(userId);
  const window = monthWindow(now, timeZone, AI_AVERAGE_MONTHS);
  const earliest = window[0];
  const current = window[window.length - 1];
  if (!earliest || !current) return null;

  const { list, total } = await topExpenseCategories(userId, earliest.start, current.end);
  if (total.isZero()) return null;

  const divisor = new Prisma.Decimal(AI_AVERAGE_MONTHS);
  const categoryAverages = list.map((category) => ({
    name: category.name,
    avgPerMonth: money(new Prisma.Decimal(category.total).dividedBy(divisor)),
  }));
  const currentBudgets = await readBudgetUsage(userId, current);

  return {
    currency,
    monthsAnalyzed: AI_AVERAGE_MONTHS,
    avgMonthlyExpense: money(total.dividedBy(divisor)),
    categoryAverages,
    currentBudgets,
  };
}

/**
 * Serialise a built context for the prompt. The readers are bounded by construction (≤6 months,
 * ≤8 categories, ≤8 goals), so the JSON here stays well under `AI_CONTEXT_MAX_CHARS` — a size a
 * test still asserts, since it is the guard that the prompt (and its injection surface) stays small.
 */
export function contextString(context: unknown): string {
  return JSON.stringify(context);
}

/** The current month's snapshot for the Q&A context: totals, top spend, and budget usage. */
export interface QASnapshotMonth {
  month: number;
  year: number;
  income: string;
  expense: string;
  net: string;
  topCategories: CategoryTotal[];
  budgetUsage: BudgetUsage[];
}

/**
 * Context for the financial Q&A (PROJECT_CONTEXT.md §5): a current-month snapshot plus the recent
 * months' totals, the month-over-month deltas, and each goal's standing — aggregates only (R-I1),
 * the same bounded readers the reports use. It is the ONLY thing the model sees besides the wrapped
 * question, so a question can never reach a raw transaction, description, or email.
 */
export interface QAContext {
  currency: string;
  monthsAnalyzed: number;
  currentMonth: QASnapshotMonth;
  previousMonth: { income: string; expense: string; net: string } | null;
  /** Expense change from the previous month to the current one; null with no prior month recorded. */
  momExpenseChangePct: number | null;
  /** Net change from the previous month to the current one; null with no prior month recorded. */
  momNetChangePct: number | null;
  recentMonths: MonthPoint[];
  goals: GoalProgress[];
}

/** Build the Q&A context, or null when the user has no ledger in the window and no goals (422). */
export async function readQAContext(userId: string, now = new Date()): Promise<QAContext | null> {
  const { timeZone, currency } = await readUserContext(userId);
  const window = monthWindow(now, timeZone, AI_QA_MONTHS);
  const current = window[window.length - 1];
  if (!current) return null;

  const months = await monthSeries(userId, window);
  const currentPoint = months[months.length - 1];
  if (!currentPoint) return null;

  const goals = await readGoals(userId, now);
  const hasLedger = months.some(
    (m) => !new Prisma.Decimal(m.income).isZero() || !new Prisma.Decimal(m.expense).isZero(),
  );
  if (!hasLedger && goals.length === 0) return null;

  const { list: topCategories } = await topExpenseCategories(userId, current.start, current.end);
  const budgetUsage = await readBudgetUsage(userId, current);

  const priorPoint = months[months.length - 2] ?? null;
  const previousMonth = priorPoint
    ? { income: priorPoint.income, expense: priorPoint.expense, net: priorPoint.net }
    : null;
  const momExpenseChangePct = priorPoint
    ? changePct(new Prisma.Decimal(priorPoint.expense), new Prisma.Decimal(currentPoint.expense))
    : null;
  const momNetChangePct = priorPoint
    ? changePct(new Prisma.Decimal(priorPoint.net), new Prisma.Decimal(currentPoint.net))
    : null;

  return {
    currency,
    monthsAnalyzed: AI_QA_MONTHS,
    currentMonth: {
      month: currentPoint.month,
      year: currentPoint.year,
      income: currentPoint.income,
      expense: currentPoint.expense,
      net: currentPoint.net,
      topCategories,
      budgetUsage,
    },
    previousMonth,
    momExpenseChangePct,
    momNetChangePct,
    recentMonths: months,
    goals,
  };
}
