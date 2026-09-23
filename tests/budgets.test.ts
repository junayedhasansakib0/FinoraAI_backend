import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import type { PublicBudget } from '../src/modules/budgets/budgets.service.js';
import {
  resetStore,
  seedBudget,
  seedCategory,
  seedTransaction,
  seedUser,
  store,
} from './helpers/db-double.js';

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { prismaDouble } = await import('./helpers/db-double.js');

  return { prisma: prismaDouble, disconnectPrisma: () => Promise.resolve() };
});

const app = createApp();
const BASE = '/api/v1/budgets';
const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

const asOwner = session(OWNER);
const asStranger = session(STRANGER);

beforeEach(() => {
  resetStore();
  seedUser({ id: OWNER, timezone: 'UTC' });
  seedUser({ id: STRANGER, timezone: 'UTC' });
});

describe('GET /api/v1/budgets', () => {
  it('requires an authenticated session', async () => {
    const response = await request(app).get(BASE);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns an empty list when no budgets are set', async () => {
    const response = await request(app)
      .get(`${BASE}?month=9&year=2026`)
      .set('Cookie', asOwner);
    const body = response.body as SuccessBody<{ budgets: PublicBudget[] }>;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.budgets).toEqual([]);
  });

  it('calculates spent, remaining, pctUsed, and status for overall and category budgets', async () => {
    const dining = seedCategory({ userId: OWNER, name: 'Dining', type: 'expense' });
    const salary = seedCategory({ userId: OWNER, name: 'Salary', type: 'income' });

    // Overall budget: $1,000.00
    seedBudget({
      userId: OWNER,
      categoryId: null,
      amount: '1000.00',
      month: 9,
      year: 2026,
    });

    // Dining category budget: $400.00
    seedBudget({
      userId: OWNER,
      categoryId: dining.id,
      amount: '400.00',
      month: 9,
      year: 2026,
    });

    // Transactions in Sept 2026
    seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '250.00',
      categoryId: dining.id,
      date: '2026-09-10T12:00:00.000Z',
    });
    seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '150.00',
      categoryId: null, // uncategorized expense
      date: '2026-09-15T12:00:00.000Z',
    });
    // Income transaction: should NOT count towards expenses
    seedTransaction({
      userId: OWNER,
      type: 'income',
      amount: '3000.00',
      categoryId: salary.id,
      date: '2026-09-01T12:00:00.000Z',
    });
    // Transaction in another month: should NOT count towards Sept 2026
    seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '500.00',
      categoryId: dining.id,
      date: '2026-10-05T12:00:00.000Z',
    });

    const response = await request(app)
      .get(`${BASE}?month=9&year=2026`)
      .set('Cookie', asOwner);
    const body = response.body as SuccessBody<{ budgets: PublicBudget[] }>;

    expect(response.status).toBe(200);
    expect(body.data.budgets).toHaveLength(2);

    const overall = body.data.budgets.find((b) => b.categoryId === null)!;
    expect(overall).toBeDefined();
    expect(overall.amount).toBe('1000.00');
    expect(overall.spent).toBe('400.00'); // 250 + 150
    expect(overall.remaining).toBe('600.00');
    expect(overall.pctUsed).toBe(40);
    expect(overall.status).toBe('ok');

    const catBudget = body.data.budgets.find((b) => b.categoryId === dining.id)!;
    expect(catBudget).toBeDefined();
    expect(catBudget.amount).toBe('400.00');
    expect(catBudget.spent).toBe('250.00');
    expect(catBudget.remaining).toBe('150.00');
    expect(catBudget.pctUsed).toBe(62.5);
    expect(catBudget.status).toBe('ok');
    expect(catBudget.categoryName).toBe('Dining');
  });

  it('does not leak another user budgets in list (R-A7, R-D4)', async () => {
    seedBudget({
      userId: OWNER,
      categoryId: null,
      amount: '1000.00',
      month: 9,
      year: 2026,
    });

    const response = await request(app)
      .get(`${BASE}?month=9&year=2026`)
      .set('Cookie', asStranger);
    const body = response.body as SuccessBody<{ budgets: PublicBudget[] }>;

    expect(response.status).toBe(200);
    expect(body.data.budgets).toEqual([]);
  });
});

describe('POST /api/v1/budgets', () => {
  it('creates an overall monthly budget', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({
        amount: '1500.00',
        month: 9,
        year: 2026,
        categoryId: null,
      });
    const body = response.body as SuccessBody<{ budget: PublicBudget }>;

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.budget.amount).toBe('1500.00');
    expect(body.data.budget.categoryId).toBeNull();
    expect(body.data.budget.month).toBe(9);
    expect(body.data.budget.year).toBe(2026);
    expect(body.data.budget.status).toBe('ok');
  });

  it('creates a category-scoped budget', async () => {
    const groceries = seedCategory({ userId: OWNER, name: 'Groceries', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({
        amount: '600.00',
        month: 9,
        year: 2026,
        categoryId: groceries.id,
      });
    const body = response.body as SuccessBody<{ budget: PublicBudget }>;

    expect(response.status).toBe(201);
    expect(body.data.budget.categoryId).toBe(groceries.id);
    expect(body.data.budget.categoryName).toBe('Groceries');
  });

  it('rejects duplicate budget scope with 409 CONFLICT (R-D6)', async () => {
    seedBudget({
      userId: OWNER,
      categoryId: null,
      amount: '1000.00',
      month: 9,
      year: 2026,
    });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({
        amount: '1200.00',
        month: 9,
        year: 2026,
        categoryId: null,
      });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
  });

  it('rejects budget creation for an income category', async () => {
    const salary = seedCategory({ userId: OWNER, name: 'Salary', type: 'income' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({
        amount: '1000.00',
        month: 9,
        year: 2026,
        categoryId: salary.id,
      });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 if the category belongs to another user (R-A7)', async () => {
    const strangerCat = seedCategory({ userId: STRANGER, name: 'Secret', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({
        amount: '500.00',
        month: 9,
        year: 2026,
        categoryId: strangerCat.id,
      });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('Status thresholds & exact boundary math', () => {
  it('enforces exact thresholds: 79.99% ok, 80.00% warning, 100.00% warning, 100.01% exceeded', async () => {
    // 79.99% -> ok
    const b1 = seedBudget({ userId: OWNER, categoryId: null, amount: '100.00', month: 1, year: 2026 });
    seedTransaction({ userId: OWNER, type: 'expense', amount: '79.99', date: '2026-01-10T00:00:00Z' });

    const res1 = await request(app).get(`${BASE}?month=1&year=2026`).set('Cookie', asOwner);
    const body1 = res1.body as SuccessBody<{ budgets: PublicBudget[] }>;
    const item1 = body1.data.budgets.find((b) => b.id === b1.id)!;
    expect(item1.pctUsed).toBe(79.99);
    expect(item1.status).toBe('ok');

    // 80.00% -> warning
    const b2 = seedBudget({ userId: OWNER, categoryId: null, amount: '100.00', month: 2, year: 2026 });
    seedTransaction({ userId: OWNER, type: 'expense', amount: '80.00', date: '2026-02-10T00:00:00Z' });

    const res2 = await request(app).get(`${BASE}?month=2&year=2026`).set('Cookie', asOwner);
    const body2 = res2.body as SuccessBody<{ budgets: PublicBudget[] }>;
    const item2 = body2.data.budgets.find((b) => b.id === b2.id)!;
    expect(item2.pctUsed).toBe(80);
    expect(item2.status).toBe('warning');

    // 100.00% -> warning
    const b3 = seedBudget({ userId: OWNER, categoryId: null, amount: '100.00', month: 3, year: 2026 });
    seedTransaction({ userId: OWNER, type: 'expense', amount: '100.00', date: '2026-03-10T00:00:00Z' });

    const res3 = await request(app).get(`${BASE}?month=3&year=2026`).set('Cookie', asOwner);
    const body3 = res3.body as SuccessBody<{ budgets: PublicBudget[] }>;
    const item3 = body3.data.budgets.find((b) => b.id === b3.id)!;
    expect(item3.pctUsed).toBe(100);
    expect(item3.status).toBe('warning');

    // 100.01% -> exceeded
    const b4 = seedBudget({ userId: OWNER, categoryId: null, amount: '100.00', month: 4, year: 2026 });
    seedTransaction({ userId: OWNER, type: 'expense', amount: '100.01', date: '2026-04-10T00:00:00Z' });

    const res4 = await request(app).get(`${BASE}?month=4&year=2026`).set('Cookie', asOwner);
    const body4 = res4.body as SuccessBody<{ budgets: PublicBudget[] }>;
    const item4 = body4.data.budgets.find((b) => b.id === b4.id)!;
    expect(item4.pctUsed).toBe(100.01);
    expect(item4.status).toBe('exceeded');
  });
});

describe('PATCH /api/v1/budgets/:id', () => {
  it('updates the budget amount and recalculates status', async () => {
    const budget = seedBudget({
      userId: OWNER,
      categoryId: null,
      amount: '100.00',
      month: 9,
      year: 2026,
    });
    seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '90.00',
      date: '2026-09-10T00:00:00Z',
    });

    const response = await request(app)
      .patch(`${BASE}/${budget.id}`)
      .set('Cookie', asOwner)
      .send({ amount: '200.00' });
    const body = response.body as SuccessBody<{ budget: PublicBudget }>;

    expect(response.status).toBe(200);
    expect(body.data.budget.amount).toBe('200.00');
    expect(body.data.budget.spent).toBe('90.00');
    expect(body.data.budget.remaining).toBe('110.00');
    expect(body.data.budget.pctUsed).toBe(45);
    expect(body.data.budget.status).toBe('ok');
  });

  it('returns 404 when attempting to update another user budget (R-A7)', async () => {
    const strangerBudget = seedBudget({
      userId: STRANGER,
      categoryId: null,
      amount: '100.00',
      month: 9,
      year: 2026,
    });

    const response = await request(app)
      .patch(`${BASE}/${strangerBudget.id}`)
      .set('Cookie', asOwner)
      .send({ amount: '500.00' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('DELETE /api/v1/budgets/:id', () => {
  it('deletes a budget', async () => {
    const budget = seedBudget({
      userId: OWNER,
      categoryId: null,
      amount: '100.00',
      month: 9,
      year: 2026,
    });

    const response = await request(app)
      .delete(`${BASE}/${budget.id}`)
      .set('Cookie', asOwner);

    expect(response.status).toBe(204);
    expect(store.budgets).toHaveLength(0);
  });

  it('returns 404 when attempting to delete another user budget (R-A7)', async () => {
    const strangerBudget = seedBudget({
      userId: STRANGER,
      categoryId: null,
      amount: '100.00',
      month: 9,
      year: 2026,
    });

    const response = await request(app)
      .delete(`${BASE}/${strangerBudget.id}`)
      .set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(store.budgets).toHaveLength(1);
  });
});

describe('Category deletion blocked when attached to budget (R-D7)', () => {
  it('rejects category deletion with 409 CONFLICT if a budget references it', async () => {
    const entertainment = seedCategory({
      userId: OWNER,
      name: 'Entertainment',
      type: 'expense',
    });
    const budget = seedBudget({
      userId: OWNER,
      categoryId: entertainment.id,
      amount: '200.00',
      month: 9,
      year: 2026,
    });

    // Attempting to delete category should fail with 409
    const catDeleteRes = await request(app)
      .delete(`/api/v1/categories/${entertainment.id}`)
      .set('Cookie', asOwner);
    const catBody = catDeleteRes.body as ErrorBody;

    expect(catDeleteRes.status).toBe(409);
    expect(catBody.error.code).toBe('CONFLICT');

    // Delete the budget first
    const budgetDeleteRes = await request(app)
      .delete(`${BASE}/${budget.id}`)
      .set('Cookie', asOwner);
    expect(budgetDeleteRes.status).toBe(204);

    // Now deleting the category succeeds
    const secondCatDeleteRes = await request(app)
      .delete(`/api/v1/categories/${entertainment.id}`)
      .set('Cookie', asOwner);
    expect(secondCatDeleteRes.status).toBe(204);
  });
});
