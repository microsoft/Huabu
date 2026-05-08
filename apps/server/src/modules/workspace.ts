/**
 * Centralised workspace path management.
 *
 * Two operating modes, decided at process startup by the presence of the
 * `SEDIMENT_WORKSPACE` environment variable:
 *
 *   ── Free mode (default for local dev) ──
 *     `SEDIMENT_WORKSPACE` is *unset*.
 *     The user picks any absolute directory at runtime via the client
 *     (folder picker / path input). `setWorkspacePath(absPath)` is the
 *     entry point. The active path can change during the process lifetime.
 *
 *   ── Managed mode (recommended for remote / single-tenant deployments) ──
 *     `SEDIMENT_WORKSPACE=/abs/path` is set at process start.
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
 *       canvas.json
 *       nodes/<nodeId>.md
 *       artifacts/<file>
 *       memory/preferences.md
 *       .history/{chat/<threadId>.json,intent.json,events.json}
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

// @deprecated Launch-only legacy migration. Remove once all workspaces have
// been migrated to the canvas-centric layout.
import { runMigrationIfNeeded } from './storage/migrate.js';

const ENV_KEY = 'SEDIMENT_WORKSPACE';

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
 * If `SEDIMENT_WORKSPACE` is set, lock the server to that path.
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
  _workspacePath = path.resolve(fromEnv);
  _managed = true;
  mkdirSync(_workspacePath, { recursive: true });
  // @deprecated Launch-only legacy migration. Remove once all workspaces have
  // been migrated to the canvas-centric layout.
  runMigrationIfNeeded(_workspacePath);
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
 * Also runs the legacy → canvas-centric layout migration on the new
 * workspace (no-op once it has been migrated).
 *
 * @deprecated The migration side effect is launch-only. Remove the migration
 * call and this note once all workspaces have been migrated.
 */
export function setWorkspacePath(newPath: string): void {
  if (_managed) {
    throw new Error(
      'Server is in managed mode; the workspace is fixed at startup',
    );
  }
  validateAbsolutePath(newPath);
  _workspacePath = path.resolve(newPath);
  mkdirSync(_workspacePath, { recursive: true });
  // @deprecated Launch-only legacy migration. Remove once all workspaces have
  // been migrated to the canvas-centric layout.
  runMigrationIfNeeded(_workspacePath);
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
