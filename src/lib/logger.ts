import { env } from '../config/env.js';

/**
 * Structured JSON logging (R-L1). Callers pass only non-sensitive metadata: never
 * secrets, tokens, passwords, request bodies, or AI prompts.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMeta = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinimumLevel(): LogLevel {
  if (env.isTest) return 'error';
  return env.isProduction ? 'info' : 'debug';
}

const minimumWeight = LEVEL_WEIGHT[resolveMinimumLevel()];

function write(level: LogLevel, message: string, meta?: LogMeta): void {
  if (LEVEL_WEIGHT[level] < minimumWeight) return;

  const entry = JSON.stringify({ level, time: new Date().toISOString(), message, ...meta });
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${entry}\n`);
}

export const logger = {
  debug: (message: string, meta?: LogMeta): void => write('debug', message, meta),
  info: (message: string, meta?: LogMeta): void => write('info', message, meta),
  warn: (message: string, meta?: LogMeta): void => write('warn', message, meta),
  error: (message: string, meta?: LogMeta): void => write('error', message, meta),
};
