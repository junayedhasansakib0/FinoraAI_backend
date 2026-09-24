import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

/**
 * The only place in the codebase that reads `process.env` (R-B5). Configuration is
 * validated at boot and the process refuses to start when it is invalid (R-C1).
 */

const ENV_FILE = resolve(process.cwd(), '.env');

// Tests take their configuration from vitest.config.ts so runs stay deterministic (R-T6).
if (process.env.NODE_ENV !== 'test' && existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgresql:' || protocol === 'postgres:';
  } catch {
    return false;
  }
}

/** Comma-separated CORS allowlist, e.g. `http://localhost:5173,https://app.example.com`. */
const clientOriginList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter((origin) => origin.length > 0),
  )
  .refine((origins) => origins.length > 0, 'must list at least one origin')
  .refine(
    (origins) => origins.every(isHttpOrigin),
    'every entry must be an http(s) origin such as http://localhost:5173',
  );

const postgresUrl = z.string().refine(isPostgresUrl, 'must be a postgresql:// connection string');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  CLIENT_ORIGIN: clientOriginList,
  /** Pooled connection used by the running server. */
  DATABASE_URL: postgresUrl,
  /** Direct connection used by migrations; falls back to DATABASE_URL when unset. */
  DIRECT_URL: postgresUrl.optional(),
  /** Distinct secrets so an access token can never be replayed as a refresh token (R-A2). */
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  /**
   * Optional CoinGecko demo key (Phase 9). The keyless free tier works without it; when set it
   * is sent as the `x-cg-demo-api-key` header and only ever read here on the server (R-A4).
   */
  COINGECKO_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Names and messages only — never values (R-A4).
  const problems = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`,
  );
  process.stderr.write(
    `${JSON.stringify({
      level: 'error',
      time: new Date().toISOString(),
      message: 'invalid_environment_configuration',
      problems,
    })}\n`,
  );
  process.exit(1);
}

const config = parsed.data;

export const env = {
  ...config,
  /** Migrations prefer the direct connection; everything else uses the pooled one. */
  MIGRATION_DATABASE_URL: config.DIRECT_URL ?? config.DATABASE_URL,
  isDevelopment: config.NODE_ENV === 'development',
  isProduction: config.NODE_ENV === 'production',
  isTest: config.NODE_ENV === 'test',
} as const;
