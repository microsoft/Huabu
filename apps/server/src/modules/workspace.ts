// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Centralised workspace path management.
 *
 * Two operating modes, decided at process startup by the presence of the
 * `HUABU_WORKSPACE` deployment override or the Home saved by remote setup:
 *
 *   ── Free mode (default for local dev) ──
 *     Neither an override nor a saved remote Home is configured.
 *     The user picks any absolute directory at runtime via the client
 *     (folder picker / path input). `setWorkspacePath(absPath)` is the
 *     entry point. The active path can change during the process lifetime.
 *
 *   ── Managed mode (recommended for remote / single-tenant deployments) ──
 *     `HUABU_WORKSPACE=/abs/path` or a setup Home is resolved at process start.
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

import { getDeploymentEnvironment } from '../security/deployment-settings.js';
import { resetExternalNoteSessions } from './canvas/external-watcher.js';
import { refreshCanvasDirIndex } from './storage/canvas-dirs.js';
import {
  adoptWorkspaceDirectory,
  materializesWorkspaces,
} from './storage/index.js';
import { currentWorkspaceScope } from './workspace/context.js';
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
// Leases per Workspace key. Several Workspaces can be live at once in Bubble
// mode, each with its own in-flight work.
const _workspaceOperationLeases = new Map<string, number>();
let _activatingWorkspacePath: string | null = null;

/**
 * A short-lived claim that keeps an async operation on one workspace.
 *
 * The release callback is deliberately synchronous and idempotent so callers
 * can always put it in a `finally` block without masking the operation's
 * original result.
 */
export interface WorkspaceOperationLease {
  readonly workspaceKey: string;
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
  return getWorkspaceHandle() !== null;
}

/**
 * If `HUABU_WORKSPACE` is set, lock the server to that path.
 * Must be called once at startup, before any request handlers run.
 * Throws if the env value is invalid (non-absolute) so misconfiguration
 * is surfaced loudly.
 */
export function initWorkspaceFromEnv(): void {
  const fromEnv = getDeploymentEnvironment()[ENV_KEY];
  if (!fromEnv) {
    _managed = false;
    return;
  }
  if (!path.isAbsolute(fromEnv)) {
    throw new Error(
      `${ENV_KEY} must be an absolute path, got: ${JSON.stringify(fromEnv)}`,
    );
  }
  if (!materializesWorkspaces()) {
    // `HUABU_WORKSPACE` names a folder, and this backend has none. Refusing
    // here rather than half-way through preparation, because the operator's
    // next move is a configuration change either way — and because a SQL
    // profile is already "locked at startup" without being told a path.
    throw new Error(
      `${ENV_KEY} names a Workspace folder, which the configured structured ` +
        'backend does not use. Unset it (the backend opens its own ' +
        'Workspace), or select the disk structured backend.',
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
  const workspacePath = getWorkspaceDirectory();
  if (!workspacePath) {
    throw new Error(
      'Workspace path has not been configured. ' +
        'Activate a workspace first (PUT /api/workspace) or set ' +
        `${ENV_KEY} in the environment.`,
    );
  }
  return workspacePath;
}

/**
 * The active Workspace's directory, or `null` when the backend has none.
 *
 * The honest form of {@link getWorkspacePath} for code that can cope with a
 * Workspace that is a row rather than a folder. Anything that genuinely needs
 * a directory should keep calling {@link getWorkspacePath} and let it refuse.
 */
export function getWorkspaceDirectory(): string | null {
  const scope = currentWorkspaceScope();
  if (scope !== undefined) return scope?.path ?? null;
  return _workspacePath;
}

/**
 * A stable process-local key for the active Workspace.
 *
 * Leases, admission gates, and scope bindings need to say "the same Workspace
 * as before" without needing it to be a place. On Disk that is still the
 * resolved path, so nothing about the existing behaviour changes; elsewhere it
 * is the Workspace identity.
 */
export function getWorkspaceKey(): string {
  const workspacePath = getWorkspaceDirectory();
  if (workspacePath) return workspacePath;
  const handle = getWorkspaceHandle();
  if (handle) return `workspace:${handle.workspaceId}`;
  throw new Error(
    'Workspace has not been configured. Activate a workspace first ' +
      `(PUT /api/workspace) or set ${ENV_KEY} in the environment.`,
  );
}

/**
 * The immutable identity of the Workspace this call runs in: the request's
 * own in Bubble mode, else the process-active one. `null` before
 * configuration.
 */
export function getWorkspaceHandle(): WorkspaceHandle | null {
  const scope = currentWorkspaceScope();
  if (scope !== undefined) return scope?.handle ?? null;
  return _workspaceHandle;
}

/** The process-active Workspace, whatever Workspace this call runs in. */
export function getProcessWorkspaceHandle(): WorkspaceHandle | null {
  return _workspaceHandle;
}

/** The process-active Workspace's directory, or `null`. */
export function getProcessWorkspaceDirectory(): string | null {
  return _workspacePath;
}

/**
 * Keep the Workspace this call runs in stable for an async operation.
 *
 * Multiple operations may hold leases concurrently, on one Workspace or
 * several. Switching the process-active Workspace away from a leased one is
 * rejected until its leases are released; recommitting the same Workspace
 * remains allowed.
 */
export function acquireWorkspaceOperationLease(): WorkspaceOperationLease {
  const workspaceKey = getWorkspaceKey();
  const processKey = processWorkspaceKey();

  // A pending switch moves only the process-active Workspace, so it holds
  // back new work there and nowhere else.
  if (
    _activatingWorkspacePath !== null &&
    workspaceKey === processKey &&
    _activatingWorkspacePath !== workspaceKey
  ) {
    throw new WorkspaceActivationInProgressError();
  }

  _workspaceOperationLeases.set(
    workspaceKey,
    (_workspaceOperationLeases.get(workspaceKey) ?? 0) + 1,
  );

  let released = false;
  return Object.freeze({
    workspaceKey,
    release(): void {
      if (released) return;
      released = true;
      const remaining = (_workspaceOperationLeases.get(workspaceKey) ?? 1) - 1;
      if (remaining > 0) _workspaceOperationLeases.set(workspaceKey, remaining);
      else _workspaceOperationLeases.delete(workspaceKey);
    },
  });
}

/** Whether any operation holds a lease on this Workspace key. */
export function isWorkspaceLeased(workspaceKey: string): boolean {
  return _workspaceOperationLeases.has(workspaceKey);
}

function processWorkspaceKey(): string | null {
  if (_workspacePath) return _workspacePath;
  if (_workspaceHandle) return `workspace:${_workspaceHandle.workspaceId}`;
  return null;
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

/**
 * Activate a Workspace that has no directory.
 *
 * The counterpart to {@link commitWorkspacePath} for a backend where a
 * Workspace is a row: same in-process effects — identity, cache invalidation,
 * watcher reset — with nothing to resolve on the filesystem. Kept separate
 * rather than making the path optional, so no caller can commit "a Workspace
 * somewhere" by accident.
 */
export function commitWorkspaceIdentity(workspace: WorkspaceHandle): void {
  assertNoWorkspaceActivationInProgress();
  assertProcessWorkspaceChangeAllowed(`workspace:${workspace.workspaceId}`);
  _workspaceHandle = workspace;
  _workspacePath = null;
  refreshCanvasDirIndex();
  invalidateUserSkill();
  resetExternalNoteSessions();
}

/** Refresh metadata for the active Workspace without switching namespaces. */
export function updateActiveWorkspaceHandle(
  workspace: WorkspaceHandle,
): boolean {
  if (getProcessWorkspaceHandle()?.workspaceId !== workspace.workspaceId)
    return false;
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
  assertProcessWorkspaceChangeAllowed(resolvedPath);
}

/** Refuse to move the process-active Workspace away while work holds it. */
function assertProcessWorkspaceChangeAllowed(nextKey: string): void {
  const key = processWorkspaceKey();
  if (key !== null && key !== nextKey && isWorkspaceLeased(key)) {
    throw new WorkspaceOperationInProgressError();
  }
}

function assertNoWorkspaceActivationInProgress(): void {
  if (_activatingWorkspacePath !== null) {
    throw new WorkspaceActivationInProgressError();
  }
}
