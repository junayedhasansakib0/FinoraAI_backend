import { z } from 'zod';

/**
 * Zod pieces shared by more than one module (R-N5). Anything used by a single module stays in
 * that module's `*.validation.ts`.
 */

/** cuid ids as Prisma generates them; the bound only rejects obvious junk before a query. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const idSchema = z.string().trim().regex(ID_PATTERN, 'is not a valid id');

/** `:id` route params. Unknown ids answer 404 from the service, not from here. */
export const idParamSchema = z.object({ id: idSchema });
