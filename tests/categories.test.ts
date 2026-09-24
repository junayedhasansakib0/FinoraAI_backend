import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import type { PublicCategory } from '../src/modules/categories/categories.service.js';
import {
  resetStore,
  seedBudget,
  seedCategory,
  seedTransaction,
  store,
} from './helpers/db-double.js';

/**
 * Categories suite (ARCHITECTURE.md §7, R-T3). The Prisma singleton is replaced with the shared
 * in-memory double: R-T2 forbids the hosted database and this machine has no disposable
 * Postgres. Sessions are minted from a signed access token rather than by registering, because
 * `requireAuth` only reads the cookie — the login flow itself belongs to `auth.test.ts`.
 */

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  externalApiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { prismaDouble } = await import('./helpers/db-double.js');

  return { prisma: prismaDouble, disconnectPrisma: () => Promise.resolve() };
});

const app = createApp();
const BASE = '/api/v1/categories';
const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

const asOwner = session(OWNER);

beforeEach(resetStore);

describe('GET /api/v1/categories', () => {
  it('requires a session', async () => {
    const response = await request(app).get(BASE);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns only the caller’s categories, expenses first and alphabetical inside each type', async () => {
    seedCategory({ userId: OWNER, name: 'Rent', type: 'expense' });
    seedCategory({ userId: OWNER, name: 'Salary', type: 'income', isDefault: true });
    seedCategory({ userId: OWNER, name: 'Food', type: 'expense' });
    seedCategory({ userId: STRANGER, name: 'Groceries', type: 'expense' });

    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as SuccessBody<{ categories: PublicCategory[] }>;

    expect(response.status).toBe(200);
    expect(body.data.categories.map((row) => row.name)).toEqual(['Food', 'Rent', 'Salary']);
    expect(Object.keys(body.data.categories[0] ?? {}).sort()).toEqual([
      'id',
      'isDefault',
      'name',
      'type',
    ]);
    expect(body.data.categories.at(-1)?.isDefault).toBe(true);
  });

  it('filters by type', async () => {
    seedCategory({ userId: OWNER, name: 'Rent', type: 'expense' });
    seedCategory({ userId: OWNER, name: 'Salary', type: 'income' });

    const response = await request(app).get(`${BASE}?type=income`).set('Cookie', asOwner);
    const body = response.body as SuccessBody<{ categories: PublicCategory[] }>;

    expect(response.status).toBe(200);
    expect(body.data.categories.map((row) => row.name)).toEqual(['Salary']);
  });

  it('rejects a type outside the two the app tracks', async () => {
    const response = await request(app).get(`${BASE}?type=savings`).set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/v1/categories', () => {
  it('creates a category owned by the caller', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: '  Coffee  ', type: 'expense' });
    const body = response.body as SuccessBody<{ category: PublicCategory }>;

    expect(response.status).toBe(201);
    expect(body.data.category).toEqual({
      id: store.categories[0]?.id,
      name: 'Coffee',
      type: 'expense',
      isDefault: false,
    });
    expect(store.categories.map((row) => row.userId)).toEqual([OWNER]);
  });

  it('rejects a duplicate name inside the same type with CONFLICT', async () => {
    seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'Coffee', type: 'expense' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(store.categories).toHaveLength(1);
  });

  it('allows the same name in the other type', async () => {
    seedCategory({ userId: OWNER, name: 'Bonus', type: 'income' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'Bonus', type: 'expense' });

    expect(response.status).toBe(201);
    expect(store.categories).toHaveLength(2);
  });

  it('rejects a blank name with field-level details', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: '   ', type: 'expense' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([{ field: 'name', message: 'is required' }]);
  });
});

describe('PATCH /api/v1/categories/:id', () => {
  it('renames a category', async () => {
    const seeded = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .patch(`${BASE}/${seeded.id}`)
      .set('Cookie', asOwner)
      .send({ name: 'Coffee & tea' });
    const body = response.body as SuccessBody<{ category: PublicCategory }>;

    expect(response.status).toBe(200);
    expect(body.data.category.name).toBe('Coffee & tea');
    expect(store.categories[0]?.name).toBe('Coffee & tea');
  });

  it('rejects a name a sibling of the same type already uses', async () => {
    const seeded = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
    seedCategory({ userId: OWNER, name: 'Tea', type: 'expense' });

    const response = await request(app)
      .patch(`${BASE}/${seeded.id}`)
      .set('Cookie', asOwner)
      .send({ name: 'Tea' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(store.categories[0]?.name).toBe('Coffee');
  });

  it('answers 404 — never 403 — for a category owned by someone else', async () => {
    const seeded = seedCategory({ userId: STRANGER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .patch(`${BASE}/${seeded.id}`)
      .set('Cookie', asOwner)
      .send({ name: 'Mine now' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(store.categories[0]?.name).toBe('Coffee');
  });
});

describe('DELETE /api/v1/categories/:id', () => {
  it('removes the category and keeps its transactions, uncategorised (R-D7)', async () => {
    const seeded = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
    seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '4.50',
      date: '2026-08-01T00:00:00.000Z',
      categoryId: seeded.id,
      description: 'Flat white',
    });

    const response = await request(app).delete(`${BASE}/${seeded.id}`).set('Cookie', asOwner);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(store.categories).toHaveLength(0);
    expect(store.transactions).toHaveLength(1);
    expect(store.transactions[0]?.categoryId).toBeNull();
  });

  it('refuses to delete a category a budget still points at', async () => {
    const seeded = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
    seedBudget({ userId: OWNER, categoryId: seeded.id });

    const response = await request(app).delete(`${BASE}/${seeded.id}`).set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(store.categories).toHaveLength(1);
  });

  it('answers 404 for a category owned by someone else', async () => {
    const seeded = seedCategory({ userId: STRANGER, name: 'Coffee', type: 'expense' });

    const response = await request(app).delete(`${BASE}/${seeded.id}`).set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(store.categories).toHaveLength(1);
  });
});
