/**
 * Prisma's `contains` filter compiles to `ILIKE '%value%'` and passes the value through
 * untouched, so wildcards a person types would otherwise be interpreted as pattern syntax:
 * searching for `50%` would match every row. Postgres treats `\` as the default `LIKE` escape
 * character, so escaping it plus the two wildcards makes the search literal (R-V5).
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
