import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { disconnectPrisma } from './lib/prisma.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info('server_started', { port: env.PORT, environment: env.NODE_ENV });
});

/** Stop accepting connections, then release the database pool before exiting. */
function shutdown(signal: NodeJS.Signals): void {
  logger.info('server_stopping', { signal });

  server.close(() => {
    void disconnectPrisma().then(() => {
      process.exit(0);
    });
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
