import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
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
