import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { AUTH_COOKIES } from '../src/config/constants.js';
import type { ErrorBody, SuccessBody } from '../src/lib/api-response.js';
import { createApp } from '../src/app.js';
import type { PublicUser } from '../src/modules/auth/auth.service.js';

/**
 * Auth suite (ARCHITECTURE.md §6/§7). The Prisma singleton is replaced with an in-memory
 * double: R-T2 forbids running tests against the hosted database and no disposable Postgres
 * is available on this machine. The rate limiters are stubbed so the suite cannot exhaust the
 * real 20-per-15-minutes credential budget — the stub still records that it was mounted.
 */

interface StoredUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  currency: string;
  timezone: string;
  tokenVersion: number;
  createdAt: Date;
  updatedAt: Date;
  categoryCount: number;
}

interface UserCreateArgs {
  data: {
    name: string;
    email: string;
    passwordHash: string;
    categories: { create: unknown[] };
  };
  select: Record<string, boolean>;
}

interface UserFindArgs {
  where: { id?: string; email?: string };
  select: Record<string, boolean>;
}

interface UserUpdateArgs {
  where: { id: string };
  data: {
    name?: string;
    currency?: string;
    timezone?: string;
    passwordHash?: string;
    tokenVersion?: { increment: number };
  };
  select: Record<string, boolean>;
}

const state = vi.hoisted(() => ({
  users: new Map<string, StoredUser>(),
  authLimiterHits: 0,
}));

vi.mock('../src/middleware/rate-limit.js', () => ({
  globalRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
  authRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    state.authLimiterHits += 1;
    next();
  },
  externalApiRateLimiter: (_req: Request, _res: Response, next: NextFunction) => {
    next();
  },
}));

vi.mock('../src/lib/prisma.js', async () => {
  const { Prisma } = await import('../src/generated/prisma/client.js');
  let sequence = 0;

  /** Honours the caller's `select`, so a field the service forgot to exclude would show up. */
  function project(row: StoredUser, select: Record<string, boolean>): Record<string, unknown> {
    const projection: Record<string, unknown> = {};
    for (const [field, wanted] of Object.entries(select)) {
      if (wanted) {
        projection[field] = row[field as keyof StoredUser];
      }
    }
    return projection;
  }

  return {
    prisma: {
      user: {
        create({ data, select }: UserCreateArgs): Promise<Record<string, unknown>> {
          const taken = [...state.users.values()].some((row) => row.email === data.email);
          if (taken) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
              }),
            );
          }

          sequence += 1;
          const row: StoredUser = {
            id: `usr_${String(sequence)}`,
            name: data.name,
            email: data.email,
            passwordHash: data.passwordHash,
            currency: 'USD',
            timezone: 'UTC',
            tokenVersion: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            categoryCount: data.categories.create.length,
          };
          state.users.set(row.id, row);

          return Promise.resolve(project(row, select));
        },

        findUnique({ where, select }: UserFindArgs): Promise<Record<string, unknown> | null> {
          const match = [...state.users.values()].find(
            (row) =>
              (where.id !== undefined && row.id === where.id) ||
              (where.email !== undefined && row.email === where.email),
          );
          return Promise.resolve(match ? project(match, select) : null);
        },

        update({ where, data, select }: UserUpdateArgs): Promise<Record<string, unknown>> {
          const row = state.users.get(where.id);
          if (!row) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('Record not found', {
                code: 'P2025',
                clientVersion: 'test',
              }),
            );
          }

          if (data.name !== undefined) row.name = data.name;
          if (data.currency !== undefined) row.currency = data.currency;
          if (data.timezone !== undefined) row.timezone = data.timezone;
          if (data.passwordHash !== undefined) row.passwordHash = data.passwordHash;
          if (data.tokenVersion !== undefined) row.tokenVersion += data.tokenVersion.increment;
          row.updatedAt = new Date();

          return Promise.resolve(project(row, select));
        },
      },
    },
    disconnectPrisma: () => Promise.resolve(),
  };
});

const app = createApp();

const BASE = '/api/v1/auth';
const PASSWORD = 'correct-horse-battery';

interface SessionBody {
  user: PublicUser;
}

function setCookies(response: request.Response): string[] {
  const raw = response.headers['set-cookie'] as unknown;
  return Array.isArray(raw) ? (raw as string[]) : [];
}

function cookie(response: request.Response, name: string): string {
  const found = setCookies(response).find((entry) => entry.startsWith(`${name}=`));
  expect(found, `expected a ${name} cookie`).toBeDefined();
  return found as string;
}

function valueOf(header: string): string {
  return header.slice(header.indexOf('=') + 1, header.indexOf(';'));
}

/** A fresh agent keeps its own cookie jar, so sessions in different tests cannot bleed. */
async function registerAccount(email: string): Promise<{
  agent: ReturnType<typeof request.agent>;
  response: request.Response;
}> {
  const agent = request.agent(app);
  const response = await agent
    .post(`${BASE}/register`)
    .send({ name: 'Ada Lovelace', email, password: PASSWORD });

  expect(response.status).toBe(201);
  return { agent, response };
}

describe('POST /api/v1/auth/register', () => {
  it('creates the account, seeds the category catalog, and issues cookies', async () => {
    const { response } = await registerAccount('ada@example.com');
    const body = response.body as SuccessBody<SessionBody>;

    expect(body.success).toBe(true);
    expect(Object.keys(body.data)).toEqual(['user']);
    expect(Object.keys(body.data.user).sort()).toEqual([
      'createdAt',
      'currency',
      'email',
      'id',
      'name',
      'timezone',
    ]);
    expect(body.data.user.email).toBe('ada@example.com');

    const seeded = [...state.users.values()].find((row) => row.email === 'ada@example.com');
    expect(seeded?.categoryCount).toBe(15);

    // Tokens live in cookies only — never in the payload (R-A3).
    const accessToken = valueOf(cookie(response, AUTH_COOKIES.access.name));
    expect(accessToken.length).toBeGreaterThan(0);
    expect(response.text).not.toContain(accessToken);
  });

  it('scopes and hardens both cookies', async () => {
    const { response } = await registerAccount('cookies@example.com');
    const access = cookie(response, AUTH_COOKIES.access.name);
    const refresh = cookie(response, AUTH_COOKIES.refresh.name);

    for (const header of [access, refresh]) {
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      // Development and test serve plain HTTP; Secure is asserted separately.
      expect(header).not.toContain('Secure');
    }

    expect(access).toContain('Path=/;');
    expect(refresh).toContain(`Path=${AUTH_COOKIES.refresh.path};`);
  });

  it('rejects a duplicate email with CONFLICT', async () => {
    await registerAccount('taken@example.com');

    const response = await request(app)
      .post(`${BASE}/register`)
      .send({ name: 'Someone Else', email: 'taken@example.com', password: PASSWORD });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
    expect(setCookies(response)).toHaveLength(0);
  });

  it('rejects a short password with field-level details', async () => {
    const response = await request(app)
      .post(`${BASE}/register`)
      .send({ name: 'Ada', email: 'short@example.com', password: 'abc' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual([
      { field: 'password', message: 'must be at least 8 characters' },
    ]);
  });

  it('stores the email lowercased and trimmed', async () => {
    await registerAccount('  MixedCase@Example.COM  ');

    const stored = [...state.users.values()].some((row) => row.email === 'mixedcase@example.com');
    expect(stored).toBe(true);
  });

  it('runs behind the credential rate limiter', () => {
    expect(state.authLimiterHits).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/auth/login', () => {
  it('returns the user and a fresh cookie pair', async () => {
    await registerAccount('login@example.com');

    const response = await request(app)
      .post(`${BASE}/login`)
      .send({ email: 'LOGIN@example.com', password: PASSWORD });
    const body = response.body as SuccessBody<SessionBody>;

    expect(response.status).toBe(200);
    expect(body.data.user.email).toBe('login@example.com');
    expect(cookie(response, AUTH_COOKIES.access.name)).toBeDefined();
    expect(cookie(response, AUTH_COOKIES.refresh.name)).toBeDefined();
  });

  it('answers a wrong password and an unknown email identically', async () => {
    await registerAccount('known@example.com');

    const wrongPassword = await request(app)
      .post(`${BASE}/login`)
      .send({ email: 'known@example.com', password: 'not-the-password' });
    const unknownEmail = await request(app)
      .post(`${BASE}/login`)
      .send({ email: 'nobody@example.com', password: PASSWORD });

    for (const response of [wrongPassword, unknownEmail]) {
      const body = response.body as ErrorBody;
      expect(response.status).toBe(401);
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
      expect(setCookies(response)).toHaveLength(0);
    }

    expect((wrongPassword.body as ErrorBody).error.message).toBe(
      (unknownEmail.body as ErrorBody).error.message,
    );
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the signed-in user', async () => {
    const { agent } = await registerAccount('me@example.com');

    const response = await agent.get(`${BASE}/me`);
    const body = response.body as SuccessBody<SessionBody>;

    expect(response.status).toBe(200);
    expect(body.data.user.email).toBe('me@example.com');
  });

  it('rejects a request with no access cookie', async () => {
    const response = await request(app).get(`${BASE}/me`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a forged access cookie', async () => {
    const response = await request(app)
      .get(`${BASE}/me`)
      .set('Cookie', `${AUTH_COOKIES.access.name}=not.a.jwt`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  it('rotates both cookies and keeps the session usable', async () => {
    const { agent, response: registered } = await registerAccount('refresh@example.com');
    const originalRefresh = valueOf(cookie(registered, AUTH_COOKIES.refresh.name));

    const response = await agent.post(`${BASE}/refresh`);
    const body = response.body as SuccessBody<SessionBody>;

    expect(response.status).toBe(200);
    expect(body.data.user.email).toBe('refresh@example.com');
    expect(cookie(response, AUTH_COOKIES.access.name)).toBeDefined();
    expect(valueOf(cookie(response, AUTH_COOKIES.refresh.name)).length).toBeGreaterThan(0);
    expect(originalRefresh.length).toBeGreaterThan(0);

    expect((await agent.get(`${BASE}/me`)).status).toBe(200);
  });

  it('rejects a refresh token whose tokenVersion is stale', async () => {
    const { agent } = await registerAccount('stale@example.com');

    // A password change bumps tokenVersion; every refresh token issued before it dies.
    const stored = [...state.users.values()].find((row) => row.email === 'stale@example.com');
    expect(stored).toBeDefined();
    if (stored) {
      stored.tokenVersion += 1;
    }

    const response = await agent.post(`${BASE}/refresh`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a garbage refresh cookie', async () => {
    const response = await request(app)
      .post(`${BASE}/refresh`)
      .set('Cookie', `${AUTH_COOKIES.refresh.name}=garbage`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a request with no refresh cookie', async () => {
    const response = await request(app).post(`${BASE}/refresh`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears both cookies and ends the session', async () => {
    const { agent } = await registerAccount('logout@example.com');

    const response = await agent.post(`${BASE}/logout`);

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});

    const cleared = setCookies(response);
    expect(cleared).toHaveLength(2);
    for (const header of cleared) {
      expect(header).toMatch(/Expires=Thu, 01 Jan 1970/);
    }

    expect((await agent.get(`${BASE}/me`)).status).toBe(401);
  });

  it('requires an active session', async () => {
    const response = await request(app).post(`${BASE}/logout`);
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('PATCH /api/v1/auth/profile', () => {
  it('updates the editable fields and returns the public user only', async () => {
    const { agent } = await registerAccount('profile@example.com');

    const response = await agent
      .patch(`${BASE}/profile`)
      .send({ name: 'Ada B. Lovelace', currency: 'eur', timezone: 'Europe/London' });
    const body = response.body as SuccessBody<SessionBody>;

    expect(response.status).toBe(200);
    // Currency is upper-cased to match how it is stored.
    expect(body.data.user.name).toBe('Ada B. Lovelace');
    expect(body.data.user.currency).toBe('EUR');
    expect(body.data.user.timezone).toBe('Europe/London');
    expect(Object.keys(body.data.user).sort()).toEqual([
      'createdAt',
      'currency',
      'email',
      'id',
      'name',
      'timezone',
    ]);

    const stored = state.users.get(body.data.user.id);
    expect(stored?.currency).toBe('EUR');
  });

  it('accepts a single field and leaves the rest untouched', async () => {
    const { agent } = await registerAccount('single@example.com');

    const response = await agent.patch(`${BASE}/profile`).send({ timezone: 'Asia/Tokyo' });
    const body = response.body as SuccessBody<SessionBody>;

    expect(response.status).toBe(200);
    expect(body.data.user.timezone).toBe('Asia/Tokyo');
    expect(body.data.user.name).toBe('Ada Lovelace');
  });

  it('rejects an empty body', async () => {
    const { agent } = await registerAccount('empty@example.com');

    const response = await agent.patch(`${BASE}/profile`).send({});
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a malformed currency code', async () => {
    const { agent } = await registerAccount('badcur@example.com');

    const response = await agent.patch(`${BASE}/profile`).send({ currency: 'US' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unknown timezone', async () => {
    const { agent } = await registerAccount('badtz@example.com');

    const response = await agent.patch(`${BASE}/profile`).send({ timezone: 'Mars/Olympus' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires an active session', async () => {
    const response = await request(app).patch(`${BASE}/profile`).send({ name: 'Nobody' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('POST /api/v1/auth/change-password', () => {
  const NEW_PASSWORD = 'a-brand-new-passphrase';

  it('changes the password, bumps tokenVersion, and keeps the caller signed in', async () => {
    const { agent, response: registered } = await registerAccount('pw@example.com');
    const userId = (registered.body as SuccessBody<SessionBody>).data.user.id;
    expect(state.users.get(userId)?.tokenVersion).toBe(0);

    const response = await agent
      .post(`${BASE}/change-password`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });

    expect(response.status).toBe(200);
    // Fresh cookies are re-issued so this session survives the version bump.
    expect(cookie(response, AUTH_COOKIES.access.name)).toBeDefined();
    expect(cookie(response, AUTH_COOKIES.refresh.name)).toBeDefined();
    expect(state.users.get(userId)?.tokenVersion).toBe(1);

    // The re-issued cookies still authenticate.
    expect((await agent.get(`${BASE}/me`)).status).toBe(200);

    // The old password no longer logs in; the new one does.
    const oldLogin = await request(app)
      .post(`${BASE}/login`)
      .send({ email: 'pw@example.com', password: PASSWORD });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post(`${BASE}/login`)
      .send({ email: 'pw@example.com', password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
  });

  it('rejects a wrong current password without changing anything', async () => {
    const { agent, response: registered } = await registerAccount('wrongpw@example.com');
    const userId = (registered.body as SuccessBody<SessionBody>).data.user.id;

    const response = await agent
      .post(`${BASE}/change-password`)
      .send({ currentPassword: 'not-my-password', newPassword: NEW_PASSWORD });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
    expect(setCookies(response)).toHaveLength(0);
    expect(state.users.get(userId)?.tokenVersion).toBe(0);
  });

  it('rejects a too-short new password', async () => {
    const { agent } = await registerAccount('shortpw@example.com');

    const response = await agent
      .post(`${BASE}/change-password`)
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires an active session', async () => {
    const response = await request(app)
      .post(`${BASE}/change-password`)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const body = response.body as ErrorBody;

    expect(response.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('cookie flags in production configuration', () => {
  it('adds Secure once NODE_ENV is production', async () => {
    vi.resetModules();
    vi.doMock('../src/config/env.js', () => ({ env: { isProduction: true } }));

    const { setAuthCookies } = await import('../src/lib/auth-cookies.js');
    const captured: Array<{ name: string; options: Record<string, unknown> }> = [];
    const res = {
      cookie(name: string, _value: string, options: Record<string, unknown>) {
        captured.push({ name, options });
      },
    } as unknown as Response;

    setAuthCookies(res, { accessToken: 'access', refreshToken: 'refresh' });

    expect(captured).toHaveLength(2);
    for (const { options } of captured) {
      expect(options.secure).toBe(true);
      expect(options.httpOnly).toBe(true);
      expect(options.sameSite).toBe('lax');
    }

    vi.doUnmock('../src/config/env.js');
    vi.resetModules();
  });
});
