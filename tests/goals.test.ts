import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { createApp } from '../src/app.js';
import { signAccessToken } from '../src/lib/jwt.js';
import type { PublicSavingsGoal } from '../src/modules/goals/goals.service.js';
import { resetStore, seedSavingsGoal, seedUser, store } from './helpers/db-double.js';

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
const BASE = '/api/v1/savings-goals';
const OWNER = 'usr_owner';
const STRANGER = 'usr_stranger';

/** Fixed, far from now, so a seeded goal's deadline reckoning never depends on the wall clock. */
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-12-31T23:59:59.999Z';

function session(userId: string): string {
  return `${AUTH_COOKIES.access.name}=${signAccessToken(userId)}`;
}

const asOwner = session(OWNER);
const asStranger = session(STRANGER);

type GoalList = SuccessBody<{ goals: PublicSavingsGoal[] }>;
type GoalOne = SuccessBody<{ goal: PublicSavingsGoal }>;

beforeEach(() => {
  resetStore();
  seedUser({ id: OWNER, timezone: 'UTC' });
  seedUser({ id: STRANGER, timezone: 'UTC' });
});

describe('GET /api/v1/savings-goals', () => {
  it('requires an authenticated session', async () => {
    const response = await request(app).get(BASE);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns an empty list when no goals are set', async () => {
    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as GoalList;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.goals).toEqual([]);
  });

  it('computes progress, remaining, and completion for an in-progress goal', async () => {
    seedSavingsGoal({
      userId: OWNER,
      name: 'Emergency fund',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as GoalList;

    expect(response.status).toBe(200);
    const goal = body.data.goals[0]!;
    expect(goal.targetAmount).toBe('200.00');
    expect(goal.currentAmount).toBe('50.00');
    expect(goal.remaining).toBe('150.00');
    expect(goal.progressPct).toBe(25);
    expect(goal.completed).toBe(false);
    expect(goal.deadlineStatus).toBe('on-track');
  });

  it('caps progress at 100% and floors remaining at zero when over-saved', async () => {
    seedSavingsGoal({
      userId: OWNER,
      name: 'Laptop',
      targetAmount: '100.00',
      currentAmount: '150.00',
      deadline: FUTURE,
    });

    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as GoalList;

    const goal = body.data.goals[0]!;
    expect(goal.progressPct).toBe(100);
    expect(goal.remaining).toBe('0.00');
    expect(goal.completed).toBe(true);
  });

  it('flags a goal whose deadline has passed', async () => {
    seedSavingsGoal({
      userId: OWNER,
      name: 'Old goal',
      targetAmount: '500.00',
      currentAmount: '100.00',
      deadline: PAST,
    });

    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as GoalList;

    const goal = body.data.goals[0]!;
    expect(goal.deadlineStatus).toBe('past-deadline');
    expect(goal.daysRemaining).toBeLessThan(0);
  });

  it('orders goals by soonest deadline first', async () => {
    seedSavingsGoal({
      userId: OWNER,
      name: 'Later',
      targetAmount: '100.00',
      currentAmount: '0.00',
      deadline: '2099-01-01T00:00:00.000Z',
    });
    seedSavingsGoal({
      userId: OWNER,
      name: 'Sooner',
      targetAmount: '100.00',
      currentAmount: '0.00',
      deadline: '2098-01-01T00:00:00.000Z',
    });

    const response = await request(app).get(BASE).set('Cookie', asOwner);
    const body = response.body as GoalList;

    expect(body.data.goals.map((goal) => goal.name)).toEqual(['Sooner', 'Later']);
  });

  it('does not leak another user goals (R-A7, R-D4)', async () => {
    seedSavingsGoal({
      userId: OWNER,
      name: 'Private',
      targetAmount: '100.00',
      currentAmount: '0.00',
      deadline: FUTURE,
    });

    const response = await request(app).get(BASE).set('Cookie', asStranger);
    const body = response.body as GoalList;

    expect(response.status).toBe(200);
    expect(body.data.goals).toEqual([]);
  });
});

describe('POST /api/v1/savings-goals', () => {
  it('requires an authenticated session', async () => {
    const response = await request(app)
      .post(BASE)
      .send({ name: 'Car', targetAmount: '1000.00', deadline: '2999-12-31' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('creates a goal and defaults the current amount to zero when omitted', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'New car', targetAmount: '1000.00', deadline: '2999-12-31' });
    const body = response.body as GoalOne;

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.goal.name).toBe('New car');
    expect(body.data.goal.targetAmount).toBe('1000.00');
    expect(body.data.goal.currentAmount).toBe('0.00');
    expect(body.data.goal.remaining).toBe('1000.00');
    expect(body.data.goal.progressPct).toBe(0);
    expect(body.data.goal.completed).toBe(false);
    expect(store.savingsGoals).toHaveLength(1);
    expect(store.savingsGoals[0]!.userId).toBe(OWNER);
  });

  it('honours an initial current amount', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'Trip', targetAmount: '400.00', currentAmount: '100.00', deadline: '2999-12-31' });
    const body = response.body as GoalOne;

    expect(response.status).toBe(201);
    expect(body.data.goal.currentAmount).toBe('100.00');
    expect(body.data.goal.remaining).toBe('300.00');
    expect(body.data.goal.progressPct).toBe(25);
  });

  it('rejects a target below the minimum of one unit', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'Tiny', targetAmount: '0.50', deadline: '2999-12-31' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(store.savingsGoals).toHaveLength(0);
  });

  it('rejects a deadline that is not in the future', async () => {
    const response = await request(app)
      .post(BASE)
      .set('Cookie', asOwner)
      .send({ name: 'Past', targetAmount: '100.00', deadline: '2020-01-01' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(store.savingsGoals).toHaveLength(0);
  });
});

describe('PATCH /api/v1/savings-goals/:id', () => {
  it('records a progress update and recomputes the derived figures', async () => {
    const goal = seedSavingsGoal({
      userId: OWNER,
      name: 'Emergency fund',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app)
      .patch(`${BASE}/${goal.id}`)
      .set('Cookie', asOwner)
      .send({ currentAmount: '150.00' });
    const body = response.body as GoalOne;

    expect(response.status).toBe(200);
    expect(body.data.goal.currentAmount).toBe('150.00');
    expect(body.data.goal.remaining).toBe('50.00');
    expect(body.data.goal.progressPct).toBe(75);
    expect(body.data.goal.completed).toBe(false);
  });

  it('rejects an update with no fields', async () => {
    const goal = seedSavingsGoal({
      userId: OWNER,
      name: 'Emergency fund',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app)
      .patch(`${BASE}/${goal.id}`)
      .set('Cookie', asOwner)
      .send({});
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 rather than touch another user goal (R-A7, R-D4)', async () => {
    const goal = seedSavingsGoal({
      userId: OWNER,
      name: 'Private',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app)
      .patch(`${BASE}/${goal.id}`)
      .set('Cookie', asStranger)
      .send({ currentAmount: '150.00' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    // The owner's amount is untouched.
    expect(store.savingsGoals[0]!.currentAmount.toFixed(2)).toBe('50.00');
  });
});

describe('DELETE /api/v1/savings-goals/:id', () => {
  it('deletes the authenticated user own goal', async () => {
    const goal = seedSavingsGoal({
      userId: OWNER,
      name: 'Done',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app).delete(`${BASE}/${goal.id}`).set('Cookie', asOwner);

    expect(response.status).toBe(204);
    expect(store.savingsGoals).toHaveLength(0);
  });

  it('returns 404 rather than delete another user goal (R-A7, R-D4)', async () => {
    const goal = seedSavingsGoal({
      userId: OWNER,
      name: 'Private',
      targetAmount: '200.00',
      currentAmount: '50.00',
      deadline: FUTURE,
    });

    const response = await request(app).delete(`${BASE}/${goal.id}`).set('Cookie', asStranger);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(store.savingsGoals).toHaveLength(1);
  });
});
