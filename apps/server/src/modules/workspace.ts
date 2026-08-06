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
 *     <canvasId>/
 *       space.json
 *       nodes/<nodeId>.md
 *       artifacts/<file>
 *       memory/preferences.md
 *       .history/{chat/<threadId>.json,intent.json,events.jsonl}
 */

import path from 'node:path';

import { resetExternalNoteSessions } from './canvas/external-watcher.js';
import { refreshCanvasDirIndex } from './storage/canvas-dirs.js';
import { prepareWorkspaceOnDisk } from './workspace-prepare.js';
import { invalidateUserSkill } from '../prompt/index.js';

const ENV_KEY = 'HUABU_WORKSPACE';

let _workspacePath: string | null = null;
let _managed = false;

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
 */
export function commitWorkspacePath(resolvedPath: string): void {
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
