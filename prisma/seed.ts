import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import { BCRYPT_COST, PASSWORD_MIN_LENGTH } from '../src/config/constants.js';
import { catalogCategoryRows } from '../src/config/categories.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

/**
 * Development seed. Creates one demo user and copies the starter category catalog onto it,
 * which is the only shape §5 allows — categories are always user-owned.
 *
 * This script runs outside the application, so it reads `process.env` directly instead of
 * importing the validated app config (which would demand the full runtime environment).
 * Credentials are never hardcoded: SEED_DEMO_PASSWORD must be supplied by the operator.
 */

const DEFAULT_DEMO_EMAIL = 'demo@finora.local';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requireEnv(name: string, minLength = 1): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length < minLength) {
    fail(`Set ${name} (at least ${minLength} characters) before seeding.`);
  }
  return value;
}

if (process.env.NODE_ENV === 'production') {
  fail('Refusing to seed: NODE_ENV is production.');
}

const connectionString = process.env.DIRECT_URL?.trim() || requireEnv('DATABASE_URL');
const password = requireEnv('SEED_DEMO_PASSWORD', PASSWORD_MIN_LENGTH);
const email = (process.env.SEED_DEMO_EMAIL?.trim() || DEFAULT_DEMO_EMAIL).toLowerCase();

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

async function seed(): Promise<void> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { name: 'Demo User', email, passwordHash },
    select: { id: true },
  });

  // Idempotent: the (userId, name, type) unique constraint makes re-runs no-ops.
  const { count } = await prisma.category.createMany({
    data: catalogCategoryRows().map((row) => ({ ...row, userId: user.id })),
    skipDuplicates: true,
  });

  process.stdout.write(`${JSON.stringify({ seeded: { email, categoriesCreated: count } })}\n`);
}

try {
  await seed();
} catch (error) {
  fail(`Seed failed: ${error instanceof Error ? error.message : 'unknown error'}`);
} finally {
  await prisma.$disconnect();
}
