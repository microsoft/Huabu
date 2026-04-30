/**
 * Centralised workspace path management.
 *
 * Every storage layer resolves its directory relative to a single
 * workspace root. The root is set at runtime by the client via
 * `PUT /api/workspace` and persisted in the browser's localStorage.
 * There is no default — the user must pick a folder on first launch.
 *
 * Directory layout inside the workspace (canvas-centric):
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

import { runMigrationIfNeeded } from './storage/migrate.js';

let _workspacePath: string | null = null;

/**
 * Whether a workspace path has been configured this session.
 */
export function isWorkspaceConfigured(): boolean {
  return _workspacePath !== null;
}

/**
 * Return the workspace root path.
 *
 * Throws if not yet configured — callers that may run before the client
 * has chosen a folder should check `isWorkspaceConfigured()` first.
 */
export function getWorkspacePath(): string {
  if (!_workspacePath) {
    throw new Error(
      'Workspace path has not been configured. ' +
        'Call setWorkspacePath() first (via PUT /api/workspace).',
    );
  }
  return _workspacePath;
}

/**
 * Set the workspace root path at runtime and create the workspace folder.
 * Called by the workspace settings API when the user picks a folder.
 *
 * Also runs the legacy → canvas-centric layout migration on the new
 * workspace (no-op once it has been migrated).
 */
export function setWorkspacePath(newPath: string): void {
  _workspacePath = path.resolve(newPath);
  mkdirSync(_workspacePath, { recursive: true });
  runMigrationIfNeeded(_workspacePath);
}
