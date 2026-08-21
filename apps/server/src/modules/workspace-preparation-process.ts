// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Isolated workspace preparation.
 *
 * Workspace preparation includes synchronous filesystem calls and migrations.
 * Cloud drives and network filesystems can block those calls indefinitely, so
 * every production path runs them in a disposable child with a hard timeout.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLogger } from '../utils/logger.js';

const DEFAULT_PREPARATION_TIMEOUT_MS = 70_000;
const FORCE_KILL_GRACE_MS = 2_000;
const MAX_STDERR_CHARS = 8_192;

const log = getLogger('workspace-preparation');

type PreparationResult = { ok: true } | { ok: false; message: string };

export interface WorkspacePreparationOptions {
  timeoutMs?: number;
  workerPath?: string;
}

export class WorkspaceActivationTimeoutError extends Error {
  /** Configured timeout in whole seconds, surfaced to the UI copy. */
  readonly timeoutSeconds: number;

  constructor(timeoutMs: number) {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    super(
      `Workspace activation timed out after ${timeoutSeconds} seconds. The folder may be on an unavailable or slow cloud/network drive.`,
    );
    this.name = 'WorkspaceActivationTimeoutError';
    this.timeoutSeconds = timeoutSeconds;
  }
}

function defaultWorkerPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const bundledWorker = path.join(
    path.dirname(currentFile),
    'workspace-prepare.worker.js',
  );
  if (existsSync(bundledWorker)) return bundledWorker;
  return fileURLToPath(
    new URL('./workspace-prepare.worker.ts', import.meta.url),
  );
}

/** Run all potentially blocking filesystem preparation outside the server. */
export function runWorkspacePreparation(
  workspacePath: string,
  options: WorkspacePreparationOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PREPARATION_TIMEOUT_MS;
  const workerPath = options.workerPath ?? defaultWorkerPath();

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let stderr = '';

    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    try {
      child = fork(workerPath, [workspacePath], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_CHARS);
    });

    const timer = setTimeout(() => {
      child.kill();
      forceKillTimer = setTimeout(
        () => child.kill('SIGKILL'),
        FORCE_KILL_GRACE_MS,
      );
      forceKillTimer.unref();
      settle(new WorkspaceActivationTimeoutError(timeoutMs));
    }, timeoutMs);
    timer.unref();

    child.once('message', (raw: unknown) => {
      const result = raw as PreparationResult;
      try {
        child.disconnect();
      } catch {
        // Already disconnected by a well-behaved worker.
      }
      if (result?.ok === true) {
        settle();
      } else {
        settle(
          new Error(
            result && typeof result.message === 'string'
              ? result.message
              : 'Workspace preparation failed',
          ),
        );
      }
    });
    child.once('error', (error) => settle(error));
    child.once('exit', (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (settled) return;
      const detail = stderr.trim();
      if (detail) {
        log.error(
          { workspacePath, code, signal, detail },
          'Workspace preparation crashed',
        );
      }
      settle(
        new Error(
          `Workspace preparation process exited before completion (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
        ),
      );
    });
  });
}
