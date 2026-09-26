import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import type {
  PublicTransaction,
  TransactionPage,
} from '../src/modules/transactions/transactions.service.js';
import { resetStore, seedCategory, seedTransaction, store, prismaDouble } from './helpers/db-double.js';

/**
 * Transactions suite (ARCHITECTURE.md §7, R-T3). Same in-memory double and minted session as the
 * categories suite: R-T2 forbids the hosted database, and `requireAuth` needs nothing but the
 * access cookie.
 */

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  resendVerificationRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
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
const BASE = '/api/v1/transactions';
const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

const asOwner = session(OWNER);

beforeEach(resetStore);

/**
 * One ledger for the whole suite. `Refill 500g` exists so an unescaped `%` in a search would be
 * caught: it contains `50` without containing `50%`.
 */
function seedLedger() {
  const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
  const rent = seedCategory({ userId: OWNER, name: 'Rent', type: 'expense' });
  const salary = seedCategory({ userId: OWNER, name: 'Salary', type: 'income' });

  return {
    coffee,
    rent,
    salary,
    flatWhite: seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '4.50',
      date: '2026-08-01T09:15:00.000Z',
      categoryId: coffee.id,
      description: 'Flat white',
    }),
    beans: seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '12.00',
      date: '2026-08-05T18:00:00.000Z',
      categoryId: coffee.id,
      description: 'Beans 50% off',
    }),
    rentPaid: seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '1200.00',
      date: '2026-08-02T07:00:00.000Z',
      categoryId: rent.id,
      description: 'August rent',
    }),
    pay: seedTransaction({
      userId: OWNER,
      type: 'income',
      amount: '3000.00',
      date: '2026-08-03T12:30:00.000Z',
      categoryId: salary.id,
      description: 'August pay',
    }),
    refill: seedTransaction({
      userId: OWNER,
      type: 'expense',
      amount: '75.25',
      date: '2026-07-20T10:00:00.000Z',
      categoryId: coffee.id,
      description: 'Refill 500g',
    }),
  };
}

type Query = Record<string, string | number>;

async function listAs(userId: string, query: Query = {}) {
  const response = await request(app).get(BASE).query(query).set('Cookie', session(userId));

  return { response, body: response.body as SuccessBody<TransactionPage> };
}

function descriptionsOf(body: SuccessBody<TransactionPage>): (string | null)[] {
  return body.data.items.map((row) => row.description);
}

/** Which fields a rejection blamed; the wording itself is the schema's business. */
function fieldsOf(body: ErrorBody): string[] {
  const details = body.error.details as { field: string }[] | undefined;

  return details?.map((detail) => detail.field) ?? [];
}

describe('GET /api/v1/transactions', () => {
  it('requires a session', async () => {
    const response = await request(app).get(BASE);

    expect(response.status).toBe(401);
  });

  /**
   * Regression: the list batch must carry explicit `maxWait`/`timeout` options. Prisma's defaults
   * (maxWait 2s) are too tight for a cold or pooled free-tier connection, where the batch fails to
   * even start the transaction and the read 500s. Dropping the options would silently bring the bug
   * back, so the call shape is asserted here rather than the (untimed) result alone.
   */
  it('runs the list batch with widened transaction start/run timeouts', async () => {
    seedLedger();
    const txSpy = vi.spyOn(prismaDouble, '$transaction');

    const { response } = await listAs(OWNER);

    expect(response.status).toBe(200);
    const batchCall = txSpy.mock.calls.find(([first]) => Array.isArray(first));
    expect(batchCall).toBeDefined();
    expect(batchCall?.[1]).toMatchObject({
      maxWait: expect.any(Number) as number,
      timeout: expect.any(Number) as number,
    });
    expect((batchCall?.[1] as { maxWait: number }).maxWait).toBeGreaterThan(2000);
    txSpy.mockRestore();
  });

  it('returns the paginated envelope with totals for the whole filter', async () => {
    seedLedger();

    const { response, body } = await listAs(OWNER, { limit: 2 });

    expect(response.status).toBe(200);
    expect(Object.keys(body.data).sort()).toEqual([
      'items',
      'limit',
      'page',
      'total',
      'totalPages',
      'totals',
    ]);
    expect(body.data).toMatchObject({ page: 1, limit: 2, total: 5, totalPages: 3 });
    expect(body.data.items).toHaveLength(2);
    // Sums cover all five rows, not the two on the page.
    expect(body.data.totals).toEqual({ income: '3000.00', expense: '1291.75' });
  });

  it('pages through the newest rows first without repeating one', async () => {
    seedLedger();

    const first = await listAs(OWNER, { limit: 2, page: 1 });
    const second = await listAs(OWNER, { limit: 2, page: 2 });
    const third = await listAs(OWNER, { limit: 2, page: 3 });

    expect(descriptionsOf(first.body)).toEqual(['Beans 50% off', 'August pay']);
    expect(descriptionsOf(second.body)).toEqual(['August rent', 'Flat white']);
    expect(descriptionsOf(third.body)).toEqual(['Refill 500g']);
  });

  it('sorts by amount when asked', async () => {
    seedLedger();

    const { body } = await listAs(OWNER, { sort: 'amount', order: 'asc', limit: 2 });

    expect(descriptionsOf(body)).toEqual(['Flat white', 'Beans 50% off']);
  });

  it('applies every filter at once, and reports totals for that filter alone', async () => {
    const { coffee } = seedLedger();

    const { body } = await listAs(OWNER, {
      type: 'expense',
      categoryId: coffee.id,
      from: '2026-08-01',
      to: '2026-08-31',
      minAmount: 5,
      maxAmount: 100,
      sort: 'date',
      order: 'asc',
    });

    // Each filter removes something: the income row, the rent category, July, 4.50, and 1200.00.
    expect(descriptionsOf(body)).toEqual(['Beans 50% off']);
    expect(body.data).toMatchObject({ total: 1, totalPages: 1 });
    expect(body.data.totals).toEqual({ income: '0.00', expense: '12.00' });
  });

  it('includes everything booked on the closing day of a date-only range', async () => {
    seedLedger();

    const { body } = await listAs(OWNER, { from: '2026-08-01', to: '2026-08-01' });

    expect(descriptionsOf(body)).toEqual(['Flat white']);
  });

  it('treats a % in the search text literally (R-V5)', async () => {
    seedLedger();

    const { body } = await listAs(OWNER, { search: '50%' });

    // A wildcard would also have matched `Refill 500g`.
    expect(descriptionsOf(body)).toEqual(['Beans 50% off']);
  });

  it('treats an _ in the search text literally (R-V5)', async () => {
    seedLedger();

    const { body } = await listAs(OWNER, { search: '_ent' });

    // A wildcard would have matched `August rent`.
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
  });

  it('matches a description regardless of case', async () => {
    seedLedger();

    const { body } = await listAs(OWNER, { search: 'FLAT' });

    expect(descriptionsOf(body)).toEqual(['Flat white']);
  });

  it('never leaks another user’s rows', async () => {
    seedLedger();

    const { body } = await listAs(STRANGER);

    expect(body.data.items).toEqual([]);
    expect(body.data.totals).toEqual({ income: '0.00', expense: '0.00' });
  });

  it('rejects a range that ends before it starts', async () => {
    const { response } = await listAs(OWNER, { from: '2026-08-10', to: '2026-08-01' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'to', message: 'must not be earlier than the start of the range' },
    ]);
  });

  it('caps the page size', async () => {
    const { response } = await listAs(OWNER, { limit: 500 });

    expect(response.status).toBe(400);
  });
});

describe('POST /api/v1/transactions', () => {
  it('creates a transaction and serialises the amount as a two-decimal string', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ type: 'expense', amount: 25, categoryId: coffee.id, date: '2026-08-04' });
    const body = response.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(response.status).toBe(201);
    expect(Object.keys(body.data.transaction).sort()).toEqual([
      'amount',
      'category',
      'createdAt',
      'date',
      'description',
      'id',
      'type',
    ]);
    expect(body.data.transaction.amount).toBe('25.00');
    expect(body.data.transaction.category).toEqual({ id: coffee.id, name: 'Coffee' });
    expect(body.data.transaction.description).toBeNull();
    // A bare date is anchored to UTC, not to whatever the server thinks midnight is.
    expect(store.transactions[0]?.date.toISOString()).toBe('2026-08-04T00:00:00.000Z');
  });

  it('stores and returns a script-like description verbatim, never stripped or escaped', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
    const payload = '<script>alert(1)</script>';

    const created = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ type: 'expense', amount: '4.50', categoryId: coffee.id, description: payload, date: '2026-08-04' });
    const createdBody = created.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(created.status).toBe(201);
    // The API is JSON: the string round-trips byte-for-byte and is never rendered as HTML — the
    // client escapes on display (R-I4 / §13.15). Sanitising here would corrupt a legitimate value.
    expect(createdBody.data.transaction.description).toBe(payload);
    expect(store.transactions[0]?.description).toBe(payload);

    const fetched = await request(app)
      .get(`${BASE}/${createdBody.data.transaction.id}`)
      .set('Cookie', asOwner);
    const fetchedBody = fetched.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(fetchedBody.data.transaction.description).toBe(payload);
  });

  it('refuses a category that tracks the other direction', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ type: 'income', amount: '25.00', categoryId: coffee.id, date: '2026-08-04' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'categoryId', message: 'does not match the transaction type' },
    ]);
    expect(store.transactions).toHaveLength(0);
  });

  it('answers 404 for a category owned by someone else', async () => {
    const theirs = seedCategory({ userId: STRANGER, name: 'Coffee', type: 'expense' });

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ type: 'expense', amount: '4.50', categoryId: theirs.id, date: '2026-08-04' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects amounts outside the two-decimal money range', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    for (const amount of [12.345, 0, '1000000000.00', 'free']) {
      const response = await request(app)
        .post(BASE)
        .set('Cookie', asOwner)
        .send({ type: 'expense', amount, categoryId: coffee.id, date: '2026-08-04' });

      expect(response.status).toBe(400);
      expect(fieldsOf(response.body as ErrorBody)).toEqual(['amount']);
    }

    expect(store.transactions).toHaveLength(0);
  });

  it('rejects a date it cannot pin to a moment', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });

    // The last one has no offset, so its meaning would depend on the server's clock.
    for (const date of ['yesterday', '2026-13-01', '2026-08-04T10:00:00']) {
      const response = await request(app)
        .post(BASE)
        .set('Cookie', asOwner)
        .send({ type: 'expense', amount: '4.50', categoryId: coffee.id, date });

      expect(response.status).toBe(400);
      expect(fieldsOf(response.body as ErrorBody)).toEqual(['date']);
    }
  });

  it('rejects a date more than a day ahead (R-V3)', async () => {
    const coffee = seedCategory({ userId: OWNER, name: 'Coffee', type: 'expense' });
    const threeDaysAhead = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ type: 'expense', amount: '4.50', categoryId: coffee.id, date: threeDaysAhead });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.details).toEqual([
      { field: 'date', message: 'cannot be more than one day in the future' },
    ]);
  });
});

describe('GET /api/v1/transactions/:id', () => {
  it('returns one transaction with its category', async () => {
    const { flatWhite, coffee } = seedLedger();

    const response = await request(app).get(`${BASE}/${flatWhite.id}`).set('Cookie', asOwner);
    const body = response.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(response.status).toBe(200);
    expect(body.data.transaction.amount).toBe('4.50');
    expect(body.data.transaction.category).toEqual({ id: coffee.id, name: 'Coffee' });
  });

  it('answers 404 for an id nobody owns', async () => {
    const response = await request(app).get(`${BASE}/txn_absent`).set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects an id that could not be one (R-V1)', async () => {
    const response = await request(app).get(`${BASE}/not.an.id!`).set('Cookie', asOwner);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(fieldsOf(body)).toEqual(['id']);
  });
});

describe('PATCH /api/v1/transactions/:id', () => {
  it('changes only the fields that were sent', async () => {
    const { flatWhite } = seedLedger();

    const response = await request(app)
      .patch(`${BASE}/${flatWhite.id}`)
      .set('Cookie', asOwner)
      .send({ amount: '5.25', description: 'Flat white, large' });
    const body = response.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(response.status).toBe(200);
    expect(body.data.transaction.amount).toBe('5.25');
    expect(body.data.transaction.description).toBe('Flat white, large');
    expect(body.data.transaction.type).toBe('expense');
    expect(store.transactions[0]?.date.toISOString()).toBe('2026-08-01T09:15:00.000Z');
  });

  it('moves a transaction to another category of the same type', async () => {
    const { flatWhite, rent } = seedLedger();

    const response = await request(app)
      .patch(`${BASE}/${flatWhite.id}`)
      .set('Cookie', asOwner)
      .send({ categoryId: rent.id });
    const body = response.body as SuccessBody<{ transaction: PublicTransaction }>;

    expect(response.status).toBe(200);
    expect(body.data.transaction.category).toEqual({ id: rent.id, name: 'Rent' });
  });

  it('re-checks the category when only the type changes', async () => {
    const { flatWhite } = seedLedger();

    const response = await request(app)
      .patch(`${BASE}/${flatWhite.id}`)
      .set('Cookie', asOwner)
      .send({ type: 'income' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(fieldsOf(body)).toEqual(['categoryId']);
    expect(store.transactions[0]?.type).toBe('expense');
  });

  it('rejects a patch that would write nothing', async () => {
    const { flatWhite } = seedLedger();

    const response = await request(app)
      .patch(`${BASE}/${flatWhite.id}`)
      .set('Cookie', asOwner)
      .send({});

    expect(response.status).toBe(400);
  });
});

describe('DELETE /api/v1/transactions/:id', () => {
  it('removes the transaction and leaves the rest of the ledger alone', async () => {
    const { flatWhite } = seedLedger();

    const response = await request(app).delete(`${BASE}/${flatWhite.id}`).set('Cookie', asOwner);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(store.transactions).toHaveLength(4);
    expect(store.transactions.some((row) => row.id === flatWhite.id)).toBe(false);
  });

  it('answers 404 for an id nobody owns', async () => {
    const response = await request(app).delete(`${BASE}/txn_absent`).set('Cookie', asOwner);

    expect(response.status).toBe(404);
  });
});

describe('another user’s transaction', () => {
  it('is a 404 to read, patch, and delete — never a 403 (R-A7, R-D4)', async () => {
    const { flatWhite } = seedLedger();
    const asStranger = session(STRANGER);
    const path = `${BASE}/${flatWhite.id}`;

    const read = await request(app).get(path).set('Cookie', asStranger);
    const patched = await request(app).patch(path).set('Cookie', asStranger).send({ amount: '1' });
    const removed = await request(app).delete(path).set('Cookie', asStranger);

    expect([read.status, patched.status, removed.status]).toEqual([404, 404, 404]);
    expect(store.transactions).toHaveLength(5);
    expect(store.transactions[0]?.amount.toFixed(2)).toBe('4.50');
  });
});
