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

import { initStorage, mountStorage } from './storage/index.js';
import {
  clearWorkspacePath,
  commitWorkspacePath,
  getWorkspacePath,
  isManagedMode,
  isWorkspaceConfigured,
  reportWorkspaceStartupFailure,
  resolveWorkspacePath,
} from './workspace.js';
import { getLogger } from '../utils/logger.js';

import type { Storage } from './storage/index.js';

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

export class WorkspaceActivationInProgressError extends Error {
  constructor() {
    super('Another workspace activation is already in progress');
    this.name = 'WorkspaceActivationInProgressError';
  }
}

/**
 * Raised when the caller asks for a workspace other than the active one.
 *
 * Not a failure of the request — the choice is valid and the client should
 * persist it. What cannot happen is this process serving it: connections,
 * caches, and directory indexes are opened against one workspace and the
 * machinery to move a live process between two of them costs more than the
 * feature is worth (issue #126). The client saves the path and restarts.
 */
export class WorkspaceRestartRequiredError extends Error {
  /** The workspace the caller asked for, to persist for the next launch. */
  readonly requestedPath: string;

  constructor(requestedPath: string) {
    super(
      'Changing the workspace takes effect after a restart. The selection has ' +
        'been validated; save it and start the server again to open it.',
    );
    this.name = 'WorkspaceRestartRequiredError';
    this.requestedPath = requestedPath;
  }
}

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

/**
 * Prepare and open the one workspace this process will serve.
 *
 * Free mode's first — and only — activation. The disposable child prepares and
 * migrates the directory, the path is committed, and storage mounts against
 * it; the sequence is linear because there is no previous workspace to keep
 * serving while it runs (proposal §12.6.5). A failure leaves the process
 * unconfigured, which is the state the client already knows how to recover
 * from, rather than half-activated.
 *
 * Asking for a *different* workspace once one is active raises
 * {@link WorkspaceRestartRequiredError} without touching a thing. Asking for
 * the active one again is a no-op, because the client re-sends its remembered
 * path on every boot and a second tab must not be told to restart.
 */
export async function activateWorkspacePath(
  newPath: string,
  options: PreparationOptions = {},
): Promise<void> {
  if (isManagedMode()) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  const resolvedPath = resolveWorkspacePath(newPath);
  if (isWorkspaceConfigured()) {
    if (getWorkspacePath() === resolvedPath) return;
    throw new WorkspaceRestartRequiredError(resolvedPath);
  }
  if (activationInProgress) {
    throw new WorkspaceActivationInProgressError();
  }

  activationInProgress = true;
  try {
    await runWorkspacePreparation(resolvedPath, options);
    commitWorkspacePath(resolvedPath);
    try {
      await mountStorage();
    } catch (error) {
      // The path is committed but nothing serves it. Unconfigure rather than
      // leave a workspace that looks active and has no store behind it — the
      // client would then be told it is ready, and every later request would
      // fail in a place that cannot explain why.
      clearWorkspacePath();
      throw error;
    }
  } finally {
    activationInProgress = false;
  }
}

/**
 * Open storage on the workspace this process was started on.
 *
 * The startup counterpart to {@link activateWorkspacePath}, and the same
 * failure rule as {@link initWorkspaceFromEnv}: an operator's workspace that
 * will not open fails the boot, a shell-chosen one leaves the process
 * unconfigured with the reason recorded, and a process with no workspace yet
 * only has its profile validated. Returns the mount, or `null` when there was
 * nothing to mount.
 */
export async function mountStartupWorkspace(): Promise<Storage | null> {
  try {
    return await initStorage();
  } catch (error) {
    // Nothing was configured, so this is the profile itself refusing — a
    // misconfiguration no workspace choice can recover from.
    if (isManagedMode() || !isWorkspaceConfigured()) throw error;
    reportWorkspaceStartupFailure(error);
    return null;
  }
}
