import type { FastifyBaseLogger } from 'fastify';

/**
 * Minimal structured logger facade. In production the Fastify/pino logger
 * is used; this helper keeps service-layer logging framework-agnostic.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(base?: FastifyBaseLogger, scope = 'livy'): Logger {
  if (!base) {
    return {
      info: (msg, meta) => console.log(`[INFO] [${scope}] ${msg}`, meta ?? ''),
      warn: (msg, meta) => console.warn(`[WARN] [${scope}] ${msg}`, meta ?? ''),
      error: (msg, meta) => console.error(`[ERROR] [${scope}] ${msg}`, meta ?? ''),
      debug: (msg, meta) => console.debug(`[DEBUG] [${scope}] ${msg}`, meta ?? ''),
    };
  }
  const child = base.child({ scope });
  return {
    info: (msg, meta) => child.info(meta ?? {}, msg),
    warn: (msg, meta) => child.warn(meta ?? {}, msg),
    error: (msg, meta) => child.error(meta ?? {}, msg),
    debug: (msg, meta) => child.debug(meta ?? {}, msg),
  };
}
