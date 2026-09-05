import { Prisma } from '../generated/prisma/client.js';

/**
 * The Prisma error codes services react to. Kept here so no module has to repeat the string
 * (R-N5) and so the mapping to an `AppError` stays uniform.
 */

const UNIQUE_VIOLATION = 'P2002';
const RECORD_NOT_FOUND = 'P2025';

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

/** A unique index rejected the write — the caller decides which CONFLICT message fits. */
export function isUniqueViolation(error: unknown): boolean {
  return hasCode(error, UNIQUE_VIOLATION);
}

/**
 * An `update`/`delete` matched no row. Because every such query is scoped by `userId`
 * (R-B2/R-D4), this also covers another user's id — which must read as 404, never 403 (R-A7).
 */
export function isRecordNotFound(error: unknown): boolean {
  return hasCode(error, RECORD_NOT_FOUND);
}
