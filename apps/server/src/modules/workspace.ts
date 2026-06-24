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
 *       canvas.json
 *       nodes/<nodeId>.md
 *       artifacts/<file>
 *       memory/preferences.md
 *       .history/{chat/<threadId>.json,intent.json,events.jsonl}
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { resetExternalNoteWatcher } from './canvas/external-watcher.js';
// @deprecated Launch-only legacy migration. Remove once all workspaces have
// been migrated to the canvas-centric layout.
import { refreshCanvasDirIndex } from './storage/canvas-dirs.js';
import { migrateBareArtifactKeys } from './storage/migrate-artifact-keys.js';
import { migrateLabeledNames } from './storage/migrate-labels.js';
import { migrateLegacyMemory } from './storage/migrate-memory.js';
import { migrateQuestionContent } from './storage/migrate-question-content.js';
import {
  flattenLegacyMetaJson,
  runMigrationIfNeeded,
} from './storage/migrate.js';
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
  _workspacePath = path.resolve(fromEnv);
  _managed = true;
  mkdirSync(_workspacePath, { recursive: true });
  // Drop the cached canvas-dir index so subsequent lookups (used by
  // migrations and route handlers) reflect the new workspace.
  refreshCanvasDirIndex();
  // @deprecated Launch-only legacy migration. Remove once all workspaces have
  // been migrated to the canvas-centric layout.
  runMigrationIfNeeded(_workspacePath);
  // One-shot meta_json -> flat YAML rewrite (sentinel-gated, idempotent).
  flattenLegacyMetaJson(_workspacePath);
  // V2 -> V3 label-based rename pass (idempotent; stays long-term).
  migrateLabeledNames(_workspacePath);
  // One-shot rewrite of legacy full artifact URLs to bare keys (sentinel-gated).
  migrateBareArtifactKeys(_workspacePath);
  // One-shot move of legacy `<canvas>/memory/preferences.md` into the
  // new `<canvas>/.memory/canvas.md` canvas-memory file (sentinel-gated).
  migrateLegacyMemory(_workspacePath);
  // One-shot flatten of question `data.input.content` -> `data.content`
  // and sidecar backfill (sentinel-gated).
  migrateQuestionContent(_workspacePath);
  void resetExternalNoteWatcher();
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
 * Also runs two storage migrations on the new workspace:
 *   - the legacy `<ws>/canvas/<id>.json` → `<ws>/<id>/canvas.json`
 *     restructuring (deprecated, launch-only);
 *   - the V2 → V3 label-based rename pass that turns `<id>`-named
 *     directories and `<nodeId>.md` files into label-derived names.
 *     This second pass is idempotent and stays in the codebase.
 *
 * @deprecated The first migration is launch-only. Remove the
 * `runMigrationIfNeeded` call once all workspaces have been migrated.
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
  // @deprecated Launch-only legacy migration. Remove once all workspaces have
  // been migrated to the canvas-centric layout.
  runMigrationIfNeeded(_workspacePath);
  // One-shot meta_json -> flat YAML rewrite (sentinel-gated, idempotent).
  flattenLegacyMetaJson(_workspacePath);
  // V2 -> V3 label-based rename pass (idempotent; stays long-term).
  migrateLabeledNames(_workspacePath);
  // One-shot rewrite of legacy full artifact URLs to bare keys (sentinel-gated).
  migrateBareArtifactKeys(_workspacePath);
  // One-shot move of legacy `<canvas>/memory/preferences.md` into the
  // new `<canvas>/.memory/canvas.md` canvas-memory file (sentinel-gated).
  migrateLegacyMemory(_workspacePath);
  // One-shot flatten of question `data.input.content` -> `data.content`
  // and sidecar backfill (sentinel-gated).
  migrateQuestionContent(_workspacePath);
  void resetExternalNoteWatcher();
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
