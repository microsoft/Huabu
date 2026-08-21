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

import {
  runWorkspacePreparation,
  type WorkspacePreparationOptions,
} from './workspace-preparation-process.js';
import {
  commitWorkspacePath,
  getWorkspacePath,
  isManagedMode,
  isWorkspaceConfigured,
  resolveWorkspacePath,
} from './workspace.js';

export {
  runWorkspacePreparation,
  WorkspaceActivationTimeoutError,
} from './workspace-preparation-process.js';

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
 * persist it. What cannot happen is this process serving it: caches, directory
 * indexes, and open handles are built against one workspace and the machinery
 * to move a live process between two of them costs more than the feature is
 * worth (issue #126). The client saves the path and restarts.
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

let activationInProgress = false;

/**
 * Prepare and adopt the one workspace this process will serve.
 *
 * Free mode's first — and only — activation: the disposable child prepares and
 * migrates the directory, and the path is committed once that has succeeded.
 * A failure commits nothing, leaving the process unconfigured, which is the
 * state the client already knows how to recover from.
 *
 * Asking for a *different* workspace once one is active prepares it in the
 * disposable child to prove it is usable, then raises
 * {@link WorkspaceRestartRequiredError} without changing process-local state.
 * Asking for the active one again is a no-op, because the client re-sends its
 * remembered path on every boot and a second tab must not be told to restart.
 */
export async function activateWorkspacePath(
  newPath: string,
  options: WorkspacePreparationOptions = {},
): Promise<void> {
  if (isManagedMode()) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  const resolvedPath = resolveWorkspacePath(newPath);
  const activePath = isWorkspaceConfigured() ? getWorkspacePath() : null;
  if (activePath === resolvedPath) return;
  if (activationInProgress) {
    throw new WorkspaceActivationInProgressError();
  }

  activationInProgress = true;
  try {
    await runWorkspacePreparation(resolvedPath, options);
    if (activePath !== null) {
      throw new WorkspaceRestartRequiredError(resolvedPath);
    }
    commitWorkspacePath(resolvedPath);
  } finally {
    activationInProgress = false;
  }
}
