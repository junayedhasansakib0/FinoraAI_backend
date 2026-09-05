import { z } from 'zod';

import { ANALYTICS_MONTHS_DEFAULT, ANALYTICS_MONTHS_MAX } from '../../config/constants.js';

/** Request schemas for `/dashboard` (ARCHITECTURE.md §7, R-V1). */

/**
 * The one input either route takes. The ceiling is what keeps the series bounded (R-B8), and the
 * default is the six months §3's bar chart draws, so the dashboard sends no query string at all.
 */
export const analyticsQuerySchema = z.object({
  months: z.coerce
    .number()
    .int()
    .min(1)
    .max(ANALYTICS_MONTHS_MAX)
    .default(ANALYTICS_MONTHS_DEFAULT),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
