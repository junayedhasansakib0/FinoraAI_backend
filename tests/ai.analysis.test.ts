import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AI_CONTEXT_MAX_CHARS } from '../src/config/constants.js';
import {
  contextString,
  readBudgetRecommendations,
  readMonthlySummary,
  readSavings,
  readSpendingAnalysis,
} from '../src/modules/ai/analysis.service.js';
import {
  resetStore,
  seedBudget,
  seedCategory,
  seedSavingsGoal,
  seedTransaction,
  seedUser,
} from './helpers/db-double.js';

/**
 * Financial Analysis Service suite (ARCHITECTURE.md §8, R-T3/R-T6). This is the ONLY place the AI
 * feature reaches Prisma (R-I1), so these tests guard the two properties the whole AI surface leans
 * on: the built context carries aggregates only — never a raw transaction, description, or id — and
 * it stays under the character budget that keeps the prompt (and its injection surface) small.
 * Every reader returns null when the user has nothing to report on, which the caller turns into 422.
 * Only `Date` is faked (R-T6): the six-month window is cut from `new Date()` on the user's calendar.
 */

vi.mock('../src/lib/prisma.js', async () => {
  const { prismaDouble } = await import('./helpers/db-double.js');

  return { prisma: prismaDouble, disconnectPrisma: () => Promise.resolve() };
});

const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';

/** Mid-September, so the six-month window (Apr–Sep 2026) sits well away from any boundary. */
const NOW = '2026-09-15T12:00:00.000Z';

/** A description no aggregate should ever carry, so a leak into the context is unmistakable (R-I1). */
const SECRET_DESCRIPTION = 'CONFIDENTIAL_MERCHANT_XYZ_9times';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  resetStore();
  seedUser({ id: OWNER });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Give the owner a couple of expense transactions this month and last, each with a private note. */
function seedTwoMonths(): void {
  const groceries = seedCategory({ userId: OWNER, name: 'Groceries', type: 'expense' });
  seedTransaction({
    userId: OWNER,
    type: 'expense',
    amount: '120.00',
    date: '2026-09-10T12:00:00.000Z',
    categoryId: groceries.id,
    description: SECRET_DESCRIPTION,
  });
  seedTransaction({
    userId: OWNER,
    type: 'income',
    amount: '3000.00',
    date: '2026-09-01T12:00:00.000Z',
    categoryId: null,
    description: SECRET_DESCRIPTION,
  });
  seedTransaction({
    userId: OWNER,
    type: 'expense',
    amount: '80.00',
    date: '2026-08-10T12:00:00.000Z',
    categoryId: groceries.id,
    description: SECRET_DESCRIPTION,
  });
}

describe('aggregates only — no raw transaction leaves the service (R-I1)', () => {
  beforeEach(seedTwoMonths);

  it('spending analysis carries category names and totals but no descriptions or ids', async () => {
    const context = await readSpendingAnalysis(OWNER, new Date());
    expect(context).not.toBeNull();

    const json = contextString(context);
    expect(json).not.toContain(SECRET_DESCRIPTION);
    expect(json).not.toContain('txn_');
    // The aggregate itself is present: the category name and its rolled-up total.
    expect(json).toContain('Groceries');
    expect(json).toContain('200.00');
  });

  it('monthly summary carries totals but no descriptions or ids', async () => {
    const context = await readMonthlySummary(OWNER, 9, 2026);
    expect(context).not.toBeNull();

    const json = contextString(context);
    expect(json).not.toContain(SECRET_DESCRIPTION);
    expect(json).not.toContain('txn_');
    expect(json).toContain('Groceries');
  });

  it('savings context carries averages but no descriptions or ids', async () => {
    const context = await readSavings(OWNER, new Date());
    expect(context).not.toBeNull();

    const json = contextString(context);
    expect(json).not.toContain(SECRET_DESCRIPTION);
    expect(json).not.toContain('txn_');
  });
});

describe('token cap — a full context stays under the character budget (R-I1, R-B8)', () => {
  beforeEach(() => {
    // The heaviest realistic shape: more categories than the top-8 cap, six months of data,
    // an overall budget, and a full set of goals with long names.
    for (let index = 0; index < 12; index += 1) {
      const category = seedCategory({
        userId: OWNER,
        name: `Spending Category Number ${String(index)} With A Long Name`,
        type: 'expense',
      });
      for (let month = 4; month <= 9; month += 1) {
        seedTransaction({
          userId: OWNER,
          type: 'expense',
          amount: '123.45',
          date: `2026-0${String(month)}-10T12:00:00.000Z`,
          categoryId: category.id,
          description: SECRET_DESCRIPTION,
        });
      }
    }
    seedTransaction({
      userId: OWNER,
      type: 'income',
      amount: '9999.99',
      date: '2026-09-02T12:00:00.000Z',
    });
    seedBudget({ userId: OWNER, categoryId: null, amount: '5000.00', month: 9, year: 2026 });
    for (let index = 0; index < 8; index += 1) {
      seedSavingsGoal({
        userId: OWNER,
        name: `Long-Term Savings Goal Number ${String(index)} For Testing`,
        targetAmount: '10000.00',
        currentAmount: '2500.00',
        deadline: '2027-06-30T00:00:00.000Z',
      });
    }
  });

  it('each of the four contexts serialises to no more than AI_CONTEXT_MAX_CHARS', async () => {
    const now = new Date();
    const contexts = [
      await readSpendingAnalysis(OWNER, now),
      await readMonthlySummary(OWNER, 9, 2026),
      await readSavings(OWNER, now),
      await readBudgetRecommendations(OWNER, now),
    ];

    for (const context of contexts) {
      expect(context).not.toBeNull();
      expect(contextString(context).length).toBeLessThanOrEqual(AI_CONTEXT_MAX_CHARS);
    }
  });

  it('never emits more than the top eight categories', async () => {
    const context = await readSpendingAnalysis(OWNER, new Date());
    expect(context?.topCategories.length).toBeLessThanOrEqual(8);
  });
});

describe('null when there is nothing to report on (→ 422)', () => {
  it('every reader returns null for a user with no transactions', async () => {
    const now = new Date();
    expect(await readSpendingAnalysis(OWNER, now)).toBeNull();
    expect(await readMonthlySummary(OWNER, 9, 2026)).toBeNull();
    expect(await readSavings(OWNER, now)).toBeNull();
    expect(await readBudgetRecommendations(OWNER, now)).toBeNull();
  });

  it('a stranger\'s ledger never bleeds into the owner\'s context (R-B2)', async () => {
    seedUser({ id: STRANGER });
    const strangerCategory = seedCategory({ userId: STRANGER, name: 'Rent', type: 'expense' });
    seedTransaction({
      userId: STRANGER,
      type: 'expense',
      amount: '900.00',
      date: '2026-09-05T12:00:00.000Z',
      categoryId: strangerCategory.id,
    });

    // The owner has no data of their own, so the report is empty despite the stranger's spending.
    expect(await readSpendingAnalysis(OWNER, new Date())).toBeNull();
  });
});
