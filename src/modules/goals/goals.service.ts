import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/app-error.js';
import { prisma } from '../../lib/prisma.js';
import type {
  CreateSavingsGoalInput,
  UpdateSavingsGoalInput,
} from './goals.validation.js';

/**
 * All business rules for `/savings-goals` (ARCHITECTURE.md §7, R-B3). Every figure the client
 * shows is worked out here: it formats the strings and draws the bar, and never divides or
 * subtracts money itself (R-B3, R-D2). Each `where` opens with `userId`, so one account can
 * neither read nor change another's goals (R-B2, R-D4, R-A7).
 */

const NO_MONEY = new Prisma.Decimal(0);
const PROGRESS_CEILING = 100;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * A defensive upper bound so the goals list can never grow into an unbounded query (R-B8, R-L5).
 * Savings goals are a small per-user set in practice; this ceiling is far above any real account
 * and exists only to keep the read bounded, never to truncate a genuine list.
 */
const MAX_SAVINGS_GOALS = 500;

export type DeadlineStatus = 'on-track' | 'past-deadline';

export interface PublicSavingsGoal {
  id: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  /** Target − current, floored at zero: a goal cannot need a negative amount (R-B3). */
  remaining: string;
  /** Percentage of the target reached, to two decimals, capped at 100 even when over-saved. */
  progressPct: number;
  /** ISO-8601 instant the goal is due by. */
  deadline: string;
  /** Whole days from `now` to the deadline; negative once the deadline has passed. */
  daysRemaining: number;
  deadlineStatus: DeadlineStatus;
  /** True once the current amount reaches or passes the target. */
  completed: boolean;
}

/** The shape read from either a stored row or a fresh write; both carry the same scalar fields. */
interface SavingsGoalRow {
  id: string;
  name: string;
  targetAmount: Prisma.Decimal;
  currentAmount: Prisma.Decimal;
  deadline: Date;
}

/** The progress a goal has made, capped at 100 so over-saving never overflows the bar (§7). */
export function computeProgressPct(current: Prisma.Decimal, target: Prisma.Decimal): number {
  if (target.lessThanOrEqualTo(NO_MONEY)) {
    return 0;
  }

  const pct = current.dividedBy(target).times(100).toDecimalPlaces(2).toNumber();

  return Math.min(pct, PROGRESS_CEILING);
}

/** A goal's public view. `now` is passed in so a test can freeze the deadline reckoning (R-T6). */
function toPublicSavingsGoal(goal: SavingsGoalRow, now: Date): PublicSavingsGoal {
  const diff = goal.targetAmount.minus(goal.currentAmount);
  const remaining = diff.isNegative() ? NO_MONEY : diff;
  const completed = goal.currentAmount.greaterThanOrEqualTo(goal.targetAmount);
  const msRemaining = goal.deadline.getTime() - now.getTime();

  return {
    id: goal.id,
    name: goal.name,
    targetAmount: goal.targetAmount.toFixed(2),
    currentAmount: goal.currentAmount.toFixed(2),
    remaining: remaining.toFixed(2),
    progressPct: computeProgressPct(goal.currentAmount, goal.targetAmount),
    deadline: goal.deadline.toISOString(),
    daysRemaining: Math.ceil(msRemaining / MS_PER_DAY),
    deadlineStatus: msRemaining < 0 ? 'past-deadline' : 'on-track',
    completed,
  };
}

/** List every goal for the authenticated user, soonest deadline first. */
export async function listSavingsGoals(
  userId: string,
  now = new Date(),
): Promise<PublicSavingsGoal[]> {
  const goals = await prisma.savingsGoal.findMany({
    where: { userId },
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: MAX_SAVINGS_GOALS,
  });

  return goals.map((goal) => toPublicSavingsGoal(goal, now));
}

/** Create a goal. An omitted initial amount starts the goal at zero (§7). */
export async function createSavingsGoal(
  userId: string,
  input: CreateSavingsGoalInput,
  now = new Date(),
): Promise<PublicSavingsGoal> {
  const goal = await prisma.savingsGoal.create({
    data: {
      userId,
      name: input.name,
      targetAmount: new Prisma.Decimal(input.targetAmount),
      currentAmount:
        input.currentAmount === undefined ? NO_MONEY : new Prisma.Decimal(input.currentAmount),
      deadline: input.deadline,
    },
  });

  return toPublicSavingsGoal(goal, now);
}

/** Update any subset of a goal's fields, including a progress update to `currentAmount`. */
export async function updateSavingsGoal(
  userId: string,
  id: string,
  input: UpdateSavingsGoalInput,
  now = new Date(),
): Promise<PublicSavingsGoal> {
  const existing = await prisma.savingsGoal.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('NOT_FOUND', 'Savings goal not found.');
  }

  const data: {
    name?: string;
    targetAmount?: Prisma.Decimal;
    currentAmount?: Prisma.Decimal;
    deadline?: Date;
  } = {};

  if (input.name !== undefined) {
    data.name = input.name;
  }
  if (input.targetAmount !== undefined) {
    data.targetAmount = new Prisma.Decimal(input.targetAmount);
  }
  if (input.currentAmount !== undefined) {
    data.currentAmount = new Prisma.Decimal(input.currentAmount);
  }
  if (input.deadline !== undefined) {
    data.deadline = input.deadline;
  }

  const goal = await prisma.savingsGoal.update({ where: { id }, data });

  return toPublicSavingsGoal(goal, now);
}

/** Delete a goal. */
export async function deleteSavingsGoal(userId: string, id: string): Promise<void> {
  const existing = await prisma.savingsGoal.findFirst({
    where: { id, userId },
    select: { id: true },
  });

  if (!existing) {
    throw new AppError('NOT_FOUND', 'Savings goal not found.');
  }

  await prisma.savingsGoal.delete({ where: { id } });
}
