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

/** Queries at or above this take are logged for index tuning (R-L2). */
const SLOW_QUERY_MS = 500;
/** The statement is truncated in the log; it holds only table/column names, never values. */
const STATEMENT_LOG_MAX = 200;

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    adapter,
    // The query text is emitted as an event, never printed, so a slow query can be logged (R-L2)
    // without ever logging its bound parameters — those hold user financial data (R-A4).
    log: env.isProduction
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });

  // Only the parameterised statement (`$1`, `$2`, …) and its duration are recorded — never
  // `event.params`, which carry the actual financial values (R-A4). Surfaces a hot query that has
  // stopped using its R-D8 index. Query events require a live connection, so this is silent in
  // tests (Prisma is mocked) and exercised at runtime.
  client.$on('query', (event) => {
    if (event.duration < SLOW_QUERY_MS) return;

    logger.warn('slow_query', {
      durationMs: event.duration,
      statement: event.query.slice(0, STATEMENT_LOG_MAX),
    });
  });

  return client;
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
