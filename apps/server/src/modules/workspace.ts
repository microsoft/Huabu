/**
 * Centralised workspace path management.
 *
 * Every storage layer (canvas, knowledge sources, artifacts) resolves its
 * directory relative to a single workspace root. The root defaults to
 * `apps/server/data/vault` but can be overridden via the
 * `SEDIMENT_WORKSPACE_PATH` environment variable.
 *
 * Directory layout inside the workspace:
 *
 *   <workspace>/
 *     canvas/
 *       default-canvas.json     – canvas state (nodes, edges, version)
 *     sources/
 *       <Title> (<sourceId>).md – knowledge sources (Markdown + YAML frontmatter)
 *     artifacts/
 *       artifact-<uuid>.<ext>   – binary files (images, PDFs, videos)
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let _workspacePath: string | null = null;

/**
 * Return the workspace root path.
 *
 * On the first call the path is resolved from (in priority order):
 *   1. The `SEDIMENT_WORKSPACE_PATH` environment variable (if set at startup)
 *   2. The default: `apps/server/data/vault` relative to this file
 *
 * Subsequent calls return the cached value. Use `setWorkspacePath()` to
 * change the path at runtime; the environment variable is NOT re-read after
 * the first initialisation.
 */
export function getWorkspacePath(): string {
  if (!_workspacePath) {
    if (process.env.SEDIMENT_WORKSPACE_PATH) {
      _workspacePath = path.resolve(process.env.SEDIMENT_WORKSPACE_PATH);
    } else {
      const here = path.dirname(fileURLToPath(import.meta.url));
      // This file lives at: apps/server/src/modules/workspace.ts
      // Default root: apps/server/data/vault
      _workspacePath = path.resolve(here, '../../data/vault');
    }
  }
  return _workspacePath;
}

/**
 * Update the workspace root path at runtime and re-create subdirectories.
 * Called by the workspace settings API.
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
