import { getLogger } from '../../utils/logger.js';

/**
 * Adapter interface used by the legacy on-boot migration helpers
 * (`migrate.ts`, `migrate-labels.ts`, `migrate-artifact-keys.ts`,
 * `migrate-question-content.ts`, `migrate-memory.ts`).
 *
 * Historically each migration declared a private duplicate of this
 * interface plus a `defaultLogger` that wrapped `console.*` with a
 * hand-rolled `[migrate-…]` tag. Now they all import {@link
 * createMigrationLogger} from this file, which routes records through
 * the shared pino root logger (see `utils/logger.ts`).
 *
 * The shape (`msg` first, `meta` second) is preserved — pino's native
 * argument order is the inverse — so existing call sites inside each
 * migration don't need touching when defaultLogger is swapped out.
 */
export interface MigrationLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Build a `MigrationLogger` tagged with `module: 'migrate.<name>'`.
 * The returned object adapts pino's `(obj, msg)` signature to the
 * migrations' historical `(msg, meta?)` signature.
 */
export function createMigrationLogger(name: string): MigrationLogger {
  const log = getLogger(`migrate.${name}`);
  return {
    info: (msg, meta) => log.info(meta ?? {}, msg),
    warn: (msg, meta) => log.warn(meta ?? {}, msg),
    error: (msg, meta) => log.error(meta ?? {}, msg),
  };
}
