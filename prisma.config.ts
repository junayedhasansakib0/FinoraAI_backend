import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 configuration. The CLI runs outside the application, so it loads `.env` itself
 * (v7 dropped automatic dotenv loading) using the same mechanism as `src/config/env.ts`.
 */

const ENV_FILE = resolve(process.cwd(), '.env');

if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Migrations and introspection use the direct (non-pooled) connection; the runtime
  // client connects through the pg adapter with DATABASE_URL instead.
  datasource: {
    url: process.env.DIRECT_URL ?? env('DATABASE_URL'),
  },
});
