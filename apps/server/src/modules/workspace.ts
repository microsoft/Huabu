// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Centralised workspace path management.
 *
 * **A process serves one workspace.** Once a workspace is active it does not
 * change for the lifetime of the process; selecting a different one persists
 * the choice and takes effect on restart (issue #126). That is what lets every
 * cache, directory index, and open handle be built once and trusted
 * afterwards, instead of each one carrying its own answer to "which workspace
 * am I looking at?".
 *
 * Three ways the one workspace is chosen, in precedence order:
 *
 *   ── Managed: `HUABU_WORKSPACE=/abs/path` ──
 *     The operator's choice, for remote / single-tenant deployments. Locked at
 *     boot by {@link initWorkspaceFromEnv}; the client gets a read-only label
 *     (the basename) and no folder-picker UI, and a workspace that cannot be
 *     prepared fails startup rather than degrading to a picker a remote user
 *     should not see. To run a different workspace, restart the process with a
 *     different env value.
 *
 *   ── Shell-chosen: `HUABU_WORKSPACE_STARTUP=/abs/path` ──
 *     The user's own choice, remembered by a shell that owns both the saved
 *     path and the server process — today the Electron main process and its
 *     `workspace.json`. Free mode otherwise: the path is shown, the picker is
 *     offered, and picking another one is a restart. A path that cannot be
 *     prepared leaves the process unconfigured with
 *     {@link getWorkspaceStartupError} set, so the shell can show the picker
 *     instead of dying.
 *
 *   ── Runtime activation (free mode, first time only) ──
 *     Neither variable is set, so the process starts unconfigured and the
 *     client activates a path through `PUT /api/workspace`. That is the
 *     browser deployment's only route, since `localStorage` cannot configure a
 *     server before it starts. It happens at most once per process; see
 *     `workspace-activation.ts`.
 *
 * Directory layout inside the active workspace (canvas-centric):
 *
 *   <workspace>/
 *     <canvasId>/
 *       space.json
 *       nodes/<nodeId>.md
 *       artifacts/<file>
 *       memory/preferences.md
 *       .history/{chat/<threadId>.json,events.jsonl}
 */

import path from 'node:path';

import { resetExternalNoteSessions } from './canvas/external-watcher.js';
import { refreshCanvasDirIndex } from './storage/canvas-dirs.js';
import { resetStorage } from './storage/index.js';
import {
  runWorkspacePreparation,
  type WorkspacePreparationOptions,
} from './workspace-preparation-process.js';
import { prepareWorkspaceOnDisk } from './workspace-prepare.js';
import { invalidateUserSkill } from '../prompt/index.js';

const ENV_KEY = 'HUABU_WORKSPACE';
const STARTUP_ENV_KEY = 'HUABU_WORKSPACE_STARTUP';

let _workspacePath: string | null = null;
let _managed = false;
let _startupError: string | null = null;

// ──────────────────────────────────────────────────────────────────────
// Mode + lifecycle
// ──────────────────────────────────────────────────────────────────────

/**
 * Whether the server is running in managed mode (workspace locked at boot).
 * In managed mode, runtime mutation APIs are rejected.
 */
export function isManagedMode(): boolean {
  return _managed;
}

export function isWorkspaceConfigured(): boolean {
  return _workspacePath !== null;
}

/**
 * Adopt the workspace this process was started on, if it was given one.
 *
 * Must be called once at startup, before any request handlers run. Handles
 * both env forms, and they differ in exactly one place — what a failure means.
 * An operator naming a workspace that cannot be prepared has misconfigured the
 * deployment, and a server that quietly came up unconfigured would offer a
 * remote user a folder picker for the host filesystem. A *shell* naming one
 * has a user whose folder moved, was renamed, or lives on a drive that is not
 * mounted today, and the recovery for that is the picker.
 */
export async function initWorkspaceFromEnv(
  options: WorkspacePreparationOptions = {},
): Promise<void> {
  const managedPath = readEnvPath(ENV_KEY);
  const startupPath = managedPath ? null : readEnvPath(STARTUP_ENV_KEY);
  const resolvedPath = managedPath ?? startupPath;
  _managed = managedPath !== null;
  _startupError = null;
  if (!resolvedPath) return;

  try {
    await runWorkspacePreparation(resolvedPath, options);
    commitWorkspacePath(resolvedPath);
  } catch (error) {
    if (_managed) throw error;
    reportWorkspaceStartupFailure(error);
  }
}

/**
 * Give up on the workspace this process was started on.
 *
 * Leaves the process unconfigured with the reason recorded, which is a state
 * the client already knows how to recover from: it shows the picker. Only ever
 * right for a *shell-chosen* workspace — an operator's `HUABU_WORKSPACE` that
 * cannot be opened is a misconfiguration, and offering a remote user a folder
 * picker for the host filesystem instead is not a recovery.
 */
export function reportWorkspaceStartupFailure(error: unknown): void {
  clearWorkspacePath();
  _startupError =
    error instanceof Error ? error.message : 'Workspace could not be opened';
}

/**
 * Return the process to its unconfigured state.
 *
 * Not a way to change workspaces — nothing is put in the old one's place. It
 * exists so an activation that fails partway leaves no half-open workspace
 * behind, and so tests can start from a clean process.
 */
export function clearWorkspacePath(): void {
  _workspacePath = null;
  dropWorkspaceScopedState();
}

/**
 * Why the workspace this process was started on could not be opened.
 *
 * `null` when there was nothing to open or it opened fine. Reported to the
 * client so a shell-chosen workspace that has gone missing explains itself in
 * the picker rather than looking like a first launch.
 */
export function getWorkspaceStartupError(): string | null {
  return _startupError;
}

// ──────────────────────────────────────────────────────────────────────
// Active workspace
// ──────────────────────────────────────────────────────────────────────

/**
 * Return the active workspace root path.
 * Throws if no workspace has been activated yet.
 */
export function getWorkspacePath(): string {
  if (!_workspacePath) {
    throw new Error(
      'Workspace path has not been configured. ' +
        'Activate a workspace first (PUT /api/workspace) or set ' +
        `${ENV_KEY} in the environment.`,
    );
  }
  return _workspacePath;
}

/**
 * Display label for the currently-active workspace. In managed mode this
 * is the basename of the locked path; in free mode it's also the basename
 * of the user-picked path. Returns `null` if nothing is active yet.
 *
 * Never reveals the full host path — safe to send to the client even when
 * the deployment treats the host filesystem as private.
 */
export function getWorkspaceName(): string | null {
  if (!_workspacePath) return null;
  return path.basename(_workspacePath);
}

/**
 * Prepare an absolute path and make it the active workspace, synchronously.
 *
 * The primitive underneath both startup paths. Production reaches a workspace
 * through {@link initWorkspaceFromEnv} or `activateWorkspacePath`, which is
 * where the "one workspace per process" rule is enforced and where preparation
 * runs in a disposable child; this function does the preparation inline and
 * enforces nothing, so it stays available to tests that drive many temporary
 * workspaces through one process.
 *
 * Also converts any legacy pi-ai `Context` chat threads on the new workspace
 * to structured turns (idempotent).
 */
export function setWorkspacePath(newPath: string): void {
  if (_managed) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  const resolvedPath = resolveWorkspacePath(newPath);
  prepareWorkspaceOnDisk(resolvedPath);
  commitWorkspacePath(resolvedPath);
}

/** Validate and normalize a user-provided workspace path. */
export function resolveWorkspacePath(newPath: string): string {
  validateAbsolutePath(newPath);
  return path.resolve(newPath);
}

/**
 * Commit an already-prepared workspace to process-local state.
 *
 * This function intentionally performs no disk I/O. Runtime activation calls
 * it only after the isolated preparation process has completed successfully.
 *
 * Production commits once, before anything has been opened against a
 * workspace. It still drops every workspace-scoped cache below, because tests
 * drive it repeatedly to move between temporary workspaces and nothing should
 * keep serving the previous one.
 */
export function commitWorkspacePath(resolvedPath: string): void {
  _workspacePath = resolvedPath;
  _startupError = null;
  dropWorkspaceScopedState();
}

/**
 * Drop everything built against whichever workspace was active.
 *
 * Storage's caches and fences, the directory index, the skill cache, and the
 * external-note watchers are all workspace-scoped, and none of them names a
 * workspace any more — dropping them here is what lets them stop. The import
 * cycles with storage and the prompt loader (both depend on
 * `getWorkspacePath` from this module) are safe because Node ESM allows
 * cycles as long as no top-level code on either side dereferences the
 * late-bound import — each of these is only called from inside a function
 * body, after both modules have finished evaluating.
 */
function dropWorkspaceScopedState(): void {
  resetStorage();
  refreshCanvasDirIndex();
  invalidateUserSkill();
  resetExternalNoteSessions();
}

// ──────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────

function validateAbsolutePath(p: string): void {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('Workspace path is required');
  }
  if (!path.isAbsolute(p)) {
    throw new Error('Workspace path must be absolute');
  }
  // On non-Windows hosts, reject Windows-style paths so we don't silently
  // create a directory literally named e.g. `C:\Users\...` under cwd.
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(p)) {
    throw new Error(
      'Windows-style path not allowed on this server (looks like data was set from a different OS)',
    );
  }
}

/** Read one env var as an absolute path, or `null` when unset. */
function readEnvPath(key: string): string | null {
  const raw = process.env[key];
  if (!raw) return null;
  if (!path.isAbsolute(raw)) {
    throw new Error(
      `${key} must be an absolute path, got: ${JSON.stringify(raw)}`,
    );
  }
  return path.resolve(raw);
}
