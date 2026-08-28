// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Isolated runtime workspace activation.
 *
 * Cloud drives and network filesystems can indefinitely block synchronous
 * filesystem calls. The legacy migrations remain synchronous for atomic,
 * ordered execution, but run in a disposable child process. Only a successful
 * preparation is committed to the Server's in-process workspace state.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  beginWorkspaceActivation,
  isManagedMode,
  resolveWorkspacePath,
  WorkspaceActivationInProgressError,
} from './workspace.js';
import { getLogger } from '../utils/logger.js';

const DEFAULT_ACTIVATION_TIMEOUT_MS = 70_000;

/**
 * Grace period between the polite `SIGTERM` and a forced `SIGKILL` when a
 * preparation child overruns its timeout. `SIGTERM` alone cannot dislodge a
 * process blocked in an uninterruptible syscall (the exact hung cloud/network
 * mount this isolation defends against), so we escalate.
 */
const FORCE_KILL_GRACE_MS = 2_000;

/** Cap on retained child stderr so a chatty failure cannot grow unbounded. */
const MAX_STDERR_CHARS = 8_192;

const log = getLogger('workspace-activation');

type PreparationResult = { ok: true } | { ok: false; message: string };

export class WorkspaceActivationTimeoutError extends Error {
  /** Configured timeout in whole seconds, surfaced to the UI copy. */
  readonly timeoutSeconds: number;

  constructor(timeoutMs: number) {
    // Round up and clamp to >= 1 so sub-second timeouts never render as an
    // awkward "0 seconds" and the copy never understates the real budget.
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    super(
      `Workspace activation timed out after ${timeoutSeconds} seconds. The folder may be on an unavailable or slow cloud/network drive.`,
    );
    this.name = 'WorkspaceActivationTimeoutError';
    this.timeoutSeconds = timeoutSeconds;
  }
}

export { WorkspaceActivationInProgressError };

interface PreparationOptions {
  timeoutMs?: number;
  workerPath?: string;
}

let activationInProgress = false;

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

/** Run all potentially blocking filesystem preparation outside the Server. */
export function runWorkspacePreparation(
  workspacePath: string,
  options: PreparationOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
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
      // Pipe stderr so an import-time crash in the worker (before its own
      // try/catch runs) is captured for diagnosis instead of vanishing.
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
      // Escalate SIGTERM -> SIGKILL: a child wedged in an uninterruptible
      // filesystem syscall ignores SIGTERM, so force-kill after a grace
      // period to guarantee the orphaned process is reaped.
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
      // Proactively close the IPC channel so a worker that reports its result
      // but forgets to `process.disconnect()` / `process.exit()` (e.g. a
      // minimal test helper) still loses the handle keeping it alive and can
      // exit, instead of lingering as an orphan.
      try {
        child.disconnect();
      } catch {
        // Already disconnected by a well-behaved worker; nothing to do.
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
      // The child has been reaped; cancel any pending force-kill.
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

/** Prepare a free-mode Workspace without changing the active Workspace. */
export async function prepareWorkspacePath(
  newPath: string,
  options: PreparationOptions = {},
): Promise<string> {
  if (isManagedMode()) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  if (activationInProgress) {
    throw new WorkspaceActivationInProgressError();
  }

  const resolvedPath = resolveWorkspacePath(newPath);
  activationInProgress = true;
  try {
    await runWorkspacePreparation(resolvedPath, options);
    return resolvedPath;
  } finally {
    activationInProgress = false;
  }
}

/** Prepare a free-mode workspace and commit it only after full success. */
export async function activateWorkspacePath(
  newPath: string,
  options: PreparationOptions = {},
): Promise<void> {
  const reservation = beginWorkspaceActivation(newPath);
  try {
    await prepareWorkspacePath(reservation.workspacePath, options);
    reservation.commit();
  } finally {
    reservation.release();
  }
}
