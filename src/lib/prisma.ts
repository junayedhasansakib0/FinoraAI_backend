import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { logger } from './logger.js';

/**
 * The single Prisma instance for the process (R-D1). Prisma 7 connects through a driver
 * adapter, so the pooled DATABASE_URL is handed to `pg` here rather than read from the
 * schema. `tsx watch` re-evaluates modules on every save, so outside production the client
 * is cached on `globalThis` to stop reloads from opening a new pool each time.
 */

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    adapter,
    // Queries are never logged: their parameters contain user financial data (R-A4).
    log: env.isProduction ? ['error'] : ['warn', 'error'],
  });
}

const globalForPrisma = globalThis as typeof globalThis & {
  finoraPrisma?: PrismaClient;
};

export const prisma: PrismaClient = globalForPrisma.finoraPrisma ?? createPrismaClient();

if (!env.isProduction) {
  globalForPrisma.finoraPrisma = prisma;
}

/** Closes the pool so the process can exit cleanly on SIGTERM/SIGINT. */
export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
  } catch (error) {
    logger.error('prisma_disconnect_failed', {
      reason: error instanceof Error ? error.message : 'unknown error',
    });
  }
}
