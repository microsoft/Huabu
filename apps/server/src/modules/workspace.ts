/**
 * Centralised workspace path management.
 *
 * Every storage layer (canvas, knowledge sources, artifacts) resolves its
 * directory relative to a single workspace root.  The root is set at
 * runtime by the client via `PUT /api/workspace` and persisted in the
 * browser's localStorage.  There is no default — the user must pick a
 * folder on first launch.
 *
 * Directory layout inside the workspace:
 *
 *   <workspace>/
 *     canvas/
 *       default-canvas.json     – canvas state (nodes, edges, version)
 *     sources/
 *       <Title>.md              – knowledge sources (Markdown + YAML frontmatter; id in frontmatter, optional dedup suffix)
 *     artifacts/
 *       artifact-<uuid>.<ext>   – binary files (images, PDFs, videos)
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

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
 * Set the workspace root path at runtime and create subdirectories.
 * Called by the workspace settings API when the user picks a folder.
 */
export function setWorkspacePath(newPath: string): void {
  _workspacePath = path.resolve(newPath);
  ensureWorkspaceDirs();
}

export function getCanvasDir(): string {
  return path.join(getWorkspacePath(), 'canvas');
}

export function getSourcesDir(): string {
  return path.join(getWorkspacePath(), 'sources');
}

export function getArtifactsDir(): string {
  return path.join(getWorkspacePath(), 'artifacts');
}

/**
 * Ensure all workspace subdirectories exist.
 * Called once at server startup from app.ts.
 */
export function ensureWorkspaceDirs(): void {
  const dirs = [getCanvasDir(), getSourcesDir(), getArtifactsDir()];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}
