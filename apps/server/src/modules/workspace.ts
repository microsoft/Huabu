// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Centralised workspace path management.
 *
 * Two operating modes, decided at process startup by the presence of the
 * `HUABU_WORKSPACE` environment variable:
 *
 *   ── Free mode (default for local dev) ──
 *     `HUABU_WORKSPACE` is *unset*.
 *     The user picks any absolute directory at runtime via the client
 *     (folder picker / path input). `setWorkspacePath(absPath)` is the
 *     entry point. The active path can change during the process lifetime.
 *
 *   ── Managed mode (recommended for remote / single-tenant deployments) ──
 *     `HUABU_WORKSPACE=/abs/path` is set at process start.
 *     The path is locked at boot via {@link initWorkspaceFromEnv} and
 *     CANNOT be changed at runtime. The client gets a read-only label
 *     (the basename of the path) and no folder-picker UI. To run a
 *     different workspace, restart the process with a different env
 *     value — typically one process per user / per workspace, with the
 *     network access controlled by your reverse proxy.
 *
 * Either way, every storage layer resolves its directory relative to a
 * single workspace root.
 *
 * Directory layout inside the active workspace (canvas-centric):
 *
 *   <workspace>/
 *     .workspace.json
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
import { adoptWorkspaceDirectory } from './storage/index.js';
import { prepareWorkspaceOnDisk } from './workspace-prepare.js';
import { invalidateUserSkill } from '../prompt/index.js';

import type { WorkspaceHandle } from './storage/index.js';

const ENV_KEY = 'HUABU_WORKSPACE';

// Identity and location are separate facts: the handle is the portable
// Workspace identity, while the path is the Disk materialization the rest of
// the Server resolves every file against. A backend that does not materialize
// Workspaces would keep the former and have no latter.
let _workspaceHandle: WorkspaceHandle | null = null;
let _workspacePath: string | null = null;
let _managed = false;
let _leasedWorkspacePath: string | null = null;
let _workspaceOperationLeaseCount = 0;
let _activatingWorkspacePath: string | null = null;

/**
 * A short-lived claim that keeps an async operation on one workspace.
 *
 * The release callback is deliberately synchronous and idempotent so callers
 * can always put it in a `finally` block without masking the operation's
 * original result.
 */
export interface WorkspaceOperationLease {
  readonly workspacePath: string;
  release(): void;
}

/** A process-local reservation for one pending active-Workspace switch. */
export interface WorkspaceActivationReservation {
  readonly workspacePath: string;
  commit(): void;
  release(): void;
}

/** Raised when a workspace switch would strand an in-flight operation. */
export class WorkspaceOperationInProgressError extends Error {
  constructor() {
    super(
      'Cannot change workspace while an operation is still using the active workspace',
    );
    this.name = 'WorkspaceOperationInProgressError';
  }
}

/** Raised when another switch already owns the active-Workspace reservation. */
export class WorkspaceActivationInProgressError extends Error {
  constructor() {
    super('Another workspace activation is already in progress');
    this.name = 'WorkspaceActivationInProgressError';
  }
}

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
  return _workspaceHandle !== null;
}

/**
 * If `HUABU_WORKSPACE` is set, lock the server to that path.
 * Must be called once at startup, before any request handlers run.
 * Throws if the env value is invalid (non-absolute) so misconfiguration
 * is surfaced loudly.
 */
export function initWorkspaceFromEnv(): void {
  const fromEnv = process.env[ENV_KEY];
  if (!fromEnv) {
    _managed = false;
    return;
  }
  if (!path.isAbsolute(fromEnv)) {
    throw new Error(
      `${ENV_KEY} must be an absolute path, got: ${JSON.stringify(fromEnv)}`,
    );
  }
  const resolvedPath = path.resolve(fromEnv);
  _managed = true;
  prepareWorkspaceOnDisk(resolvedPath);
  commitWorkspacePath(resolvedPath);
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

/** The active immutable Workspace identity, or null before configuration. */
export function getWorkspaceHandle(): WorkspaceHandle | null {
  return _workspaceHandle;
}

/**
 * Keep the currently-active workspace stable for an async operation.
 *
 * Multiple operations may hold leases concurrently. Switching to another
 * workspace is rejected until every lease has been released; recommitting the
 * same path remains allowed.
 */
export function acquireWorkspaceOperationLease(): WorkspaceOperationLease {
  const workspacePath = getWorkspacePath();

  if (
    _activatingWorkspacePath !== null &&
    _activatingWorkspacePath !== workspacePath
  ) {
    throw new WorkspaceActivationInProgressError();
  }

  if (
    _workspaceOperationLeaseCount > 0 &&
    _leasedWorkspacePath !== workspacePath
  ) {
    throw new Error('Workspace operation lease invariant violated');
  }

  _leasedWorkspacePath = workspacePath;
  _workspaceOperationLeaseCount += 1;

  let released = false;
  return Object.freeze({
    workspacePath,
    release(): void {
      if (released) return;
      released = true;
      _workspaceOperationLeaseCount -= 1;
      if (_workspaceOperationLeaseCount === 0) {
        _leasedWorkspacePath = null;
      }
    },
  });
}

/**
 * Reserve a namespace switch before asynchronous preparation can touch it.
 *
 * The reservation closes both sides of the race: an existing operation makes
 * activation fail before the target is prepared, while new operations cannot
 * start and strand themselves in the old Workspace during preparation.
 */
export function beginWorkspaceActivation(
  newPath: string,
): WorkspaceActivationReservation {
  const workspacePath = resolveWorkspacePath(newPath);
  if (_activatingWorkspacePath !== null) {
    throw new WorkspaceActivationInProgressError();
  }
  assertWorkspacePathChangeAllowed(workspacePath);
  _activatingWorkspacePath = workspacePath;

  let released = false;
  let committed = false;
  return Object.freeze({
    workspacePath,
    commit(): void {
      if (released || committed || _activatingWorkspacePath !== workspacePath) {
        throw new WorkspaceActivationInProgressError();
      }
      commitResolvedWorkspacePath(workspacePath);
      committed = true;
    },
    release(): void {
      if (released) return;
      released = true;
      if (_activatingWorkspacePath === workspacePath) {
        _activatingWorkspacePath = null;
      }
    },
  });
}

/**
 * (Free mode) Activate any absolute path as the current workspace and
 * create the workspace folder. Rejected in managed mode — the workspace
 * is locked at boot.
 *
 * Also converts any legacy pi-ai `Context` chat threads on the new
 * workspace to structured turns (idempotent).
 */
export function setWorkspacePath(newPath: string): void {
  if (_managed) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  const resolvedPath = resolveWorkspacePath(newPath);
  assertNoWorkspaceActivationInProgress();
  assertWorkspacePathChangeAllowed(resolvedPath);
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
 * Runtime activation calls this only after the isolated preparation process
 * has completed successfully. Opening the handle reads the prepared manifest;
 * the compatibility fallback creates it when an older caller committed a
 * legacy path without going through preparation first.
 *
 * The lease guard runs *before* that, so a switch this process must refuse
 * cannot leave the target adopted or registered on its way out.
 */
export function commitWorkspacePath(rawPath: string): void {
  const resolvedPath = path.resolve(rawPath);
  assertNoWorkspaceActivationInProgress();
  commitResolvedWorkspacePath(resolvedPath);
}

function commitResolvedWorkspacePath(resolvedPath: string): void {
  assertWorkspacePathChangeAllowed(resolvedPath);
  _workspaceHandle = adoptWorkspaceDirectory(resolvedPath);
  _workspacePath = resolvedPath;
  // Drop the cached canvas-dir index so subsequent lookups (used by
  // migrations and route handlers) reflect the new workspace.
  refreshCanvasDirIndex();
  // Drop any user-skill cache built against the previous workspace so
  // the next `listSkills` / `read("skills/...")` call rescans the new
  // `<workspace>/setting/skills/` from scratch. The import-cycle with
  // the prompt loader (which depends on `getWorkspacePath` from this
  // module) is safe because Node ESM allows cycles as long as no
  // top-level code on either side dereferences the late-bound import
  // — here `invalidateUserSkill` is only ever called from within
  // function bodies, after both modules have finished evaluating.
  invalidateUserSkill();
  resetExternalNoteSessions();
}

/** Refresh metadata for the active Workspace without switching namespaces. */
export function updateActiveWorkspaceHandle(
  workspace: WorkspaceHandle,
): boolean {
  if (_workspaceHandle?.workspaceId !== workspace.workspaceId) return false;
  _workspaceHandle = workspace;
  return true;
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

function assertWorkspacePathChangeAllowed(resolvedPath: string): void {
  if (
    _workspaceOperationLeaseCount > 0 &&
    _leasedWorkspacePath !== null &&
    _leasedWorkspacePath !== resolvedPath
  ) {
    throw new WorkspaceOperationInProgressError();
  }
}

function assertNoWorkspaceActivationInProgress(): void {
  if (_activatingWorkspacePath !== null) {
    throw new WorkspaceActivationInProgressError();
  }
}
