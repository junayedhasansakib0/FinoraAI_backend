import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('server_started', { port: env.PORT, environment: env.NODE_ENV });
});

/** How long to wait for in-flight requests before forcing exit, so a hung connection can't hang shutdown. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

let shuttingDown = false;

/** Stop accepting connections, then release the database pool before exiting. */
function shutdown(signal: NodeJS.Signals): void {
  // A second signal (e.g. SIGINT after SIGTERM) must not start a second teardown.
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logger.info('server_stopping', { signal });

  // Safety net: if the server or the pool refuses to close in time, exit non-zero rather than hang.
  const forceExit = setTimeout(() => {
    logger.warn('server_forced_exit', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close(() => {
    void disconnectPrisma().then(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
