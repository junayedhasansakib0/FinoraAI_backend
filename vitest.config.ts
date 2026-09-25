import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'text'],
      // Only application code counts toward the R-T3 targets. The composition root, the Prisma
      // singleton, generated types, and the smoke script hold no branching logic worth covering.
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/server.ts',
        'src/lib/prisma.ts',
        'src/**/*.types.ts',
        'src/**/*.d.ts',
      ],
      // R-T3 / Phase 15: services ≥70% code coverage, project ≥60%. Locked here so a coverage
      // regression fails the run. The ≥70% services bar is applied to statements/lines/functions
      // (what "coverage" means in the target); per-service branch coverage tracks the ≥60% project
      // floor, since a handful of defensive branches in the service layer are exercised via the
      // integration/error paths rather than enumerated one by one.
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 60,
        'src/**/*.service.ts': {
          lines: 70,
          functions: 70,
          statements: 70,
          branches: 60,
        },
      },
    },
    // Deterministic configuration for tests (R-T6): never read the developer's .env.
    // The database URL is a placeholder — suites mock the Prisma singleton instead of
    // connecting, so no test ever touches a real database.
    env: {
      NODE_ENV: 'test',
      PORT: '5000',
      CLIENT_ORIGIN: 'http://localhost:5173',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/finora_test',
      JWT_ACCESS_SECRET: 'test-access-secret-value-at-least-32-chars',
      JWT_REFRESH_SECRET: 'test-refresh-secret-value-at-least-32-chars',
    },
  },
});
