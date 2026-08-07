// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import pino, {
  destination,
  multistream,
  type Level,
  type Logger,
  type LoggerOptions,
} from 'pino';

import { getDataDir } from '../data-dir.js';

/**
 * Root pino logger for `@huabu/server`.
 *
 * One logger to rule them all:
 *   • HTTP routes get this instance via Fastify's `loggerInstance`
 *     option in `app.ts`, so `request.log.*` and `getLogger(...)` end
 *     up writing to the same streams with the same formatting.
 *   • Service / utility modules call `getLogger('subsystem')` to obtain
 *     a child logger tagged with `module: 'subsystem'`, instead of
 *     using `console.*` with hand-rolled `[tag]` prefixes.
 *
 * Output sinks (both streams receive every record above the configured
 * level — selectable via `LOG_LEVEL`, default `info`):
 *
 *   1. stdout — structured JSON, one record per line. In the packaged
 *      desktop app this is captured by Electron's main process and
 *      teed to `app.getPath('logs')/server-<timestamp>.log`
 *      (see apps/desktop/src/main.ts → openServerLogStream). In dev /
 *      standalone runs it shows up in the terminal.
 *   2. `<dataDir>/logs/server.log` — direct on-disk persistence owned
 *      by the server itself, so the dev workflow and any non-Electron
 *      launch (CI, headless evals, server-only deployments) still has
 *      a durable log file for post-mortem debugging.
 *
 * We deliberately avoid `pino.transport` (worker_threads) because tsup
 * bundles the server into a single ESM file; pino's transport loader
 * resolves targets off disk and is fragile in that layout. Both sinks
 * use SonicBoom (`pino.destination`) which runs in-process and works
 * inside the bundle without extra configuration.
 *
 * Rotation is handled at startup: when `server.log` exceeds
 * `MAX_LOG_BYTES`, it's renamed to `server.log.1` and older numbered
 * files are shifted down (keeping at most `KEEP_LOG_FILES`). This is
 * simpler than `pino-roll` and avoids the worker-thread issue above;
 * a long-running process can grow past the threshold within a single
 * boot, but in practice a server restart happens often enough (config
 * change, agent re-fork, Electron launch) that this is a fine trade.
 */

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB per file
const KEEP_LOG_FILES = 5; // server.log + .1 .. .4

const logsDir = join(getDataDir(), 'logs');
mkdirSync(logsDir, { recursive: true });

const logFilePath = join(logsDir, 'server.log');

/**
 * Rotate `server.log` if it has grown past the size threshold. Best
 * effort — any FS error is swallowed so a logging hiccup never blocks
 * server boot. Runs once at module load.
 */
function rotateAtStartup(filePath: string): void {
  try {
    const stat = statSync(filePath);
    if (stat.size < MAX_LOG_BYTES) return;
  } catch {
    // File doesn't exist yet — nothing to rotate.
    return;
  }

  // Drop the oldest file if we're at the cap, then shift the rest
  // down by one (.n → .n+1, …, .1 stays free for the current log).
  const oldest = `${filePath}.${KEEP_LOG_FILES - 1}`;
  try {
    if (existsSync(oldest)) unlinkSync(oldest);
  } catch {
    /* best-effort prune */
  }
  for (let i = KEEP_LOG_FILES - 2; i >= 1; i--) {
    const from = `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    try {
      if (existsSync(from)) renameSync(from, to);
    } catch {
      /* best-effort shift */
    }
  }
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    /* best-effort rotate */
  }
}

rotateAtStartup(logFilePath);

const level: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info';

const stdoutStream = destination({ dest: 1, sync: false });
const fileStream = destination({ dest: logFilePath, sync: false });

// Flush any buffered records on graceful shutdown / unhandled crash so
// post-mortem disk inspection isn't missing the last few lines.
const flushAll = (): void => {
  try {
    stdoutStream.flushSync();
  } catch {
    /* ignore */
  }
  try {
    fileStream.flushSync();
  } catch {
    /* ignore */
  }
};
process.on('beforeExit', flushAll);
process.on('SIGINT', flushAll);
process.on('SIGTERM', flushAll);

const options: LoggerOptions = {
  level,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Redact common credential-bearing fields so OAuth tokens, LLM API
  // keys, basic-auth headers, etc. never land on disk. Pino's redact
  // paths are AST-checked at logger construction time, so a malformed
  // path here would throw on boot rather than silently fail.
  //
  // Each secret name is listed twice: once bare (matches a top-level
  // field, e.g. `log.warn({ apiKey })`) and once wildcarded `*.<name>`
  // (matches one level of nesting, e.g. `{ config: { apiKey } }`). Pino
  // wildcards only span a single segment, so deeply-nested secrets are
  // still not covered — callers must avoid burying credentials inside
  // arbitrary logged objects.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["proxy-authorization"]',
      'apiKey',
      'api_key',
      'token',
      'password',
      'authorization',
      '*.apiKey',
      '*.api_key',
      '*.token',
      '*.password',
      '*.authorization',
    ],
    censor: '[redacted]',
  },
};

export const logger: Logger = pino(
  options,
  multistream([{ stream: stdoutStream }, { stream: fileStream }]),
);

/**
 * Return a child logger tagged with a stable `module` field, plus any
 * additional bindings. Prefer this over importing `logger` directly in
 * service modules so every record carries a subsystem name for
 * filtering.
 *
 * @example
 *   const log = getLogger('canvas-store');
 *   log.warn({ err, canvasId }, 'failed to load canvas');
 */
export function getLogger(
  module: string,
  extra: Record<string, unknown> = {},
): Logger {
  return logger.child({ module, ...extra });
}

/**
 * Absolute path to the on-disk log file. Exported for diagnostic
 * tooling (e.g. an "export support bundle" feature) and tests.
 */
export const LOG_FILE_PATH = logFilePath;
