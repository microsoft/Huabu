// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Where the Disk backend puts a Space.
 *
 * Every path here answers "how does *this* backend store that", so none of it
 * survives a switch to a structured backend that keeps the same state in
 * tables — which is the test that moved it inside the storage boundary
 * (proposal §12.5.2). Nothing outside `storage/` may depend on these names.
 *
 * Layout under `<workspace>/<canvasDir>/`:
 *
 *   space.json                    topology; carries the stable canvasId
 *   nodes/<safe(label)>.md        per-node markdown (id in frontmatter)
 *   .artifacts/<artifactId><ext>  raw uploads (hidden dir)
 *   .history/
 *     chat/<threadId>.changes.json  pending change-review records
 *     events.jsonl
 *     tasks.json
 *     delta-log.jsonl
 *
 * `.history/` also hosts state this backend does not own — ACP sessions and
 * the debug prompt log — which the agent domain addresses through the
 * materialization capability instead (§12.5.3).
 */

import path from 'node:path';

import { canvasDirName } from './canvas-dirs.js';
import { sanitizeId } from '../../../../utils/fs.js';
import { getWorkspacePath } from '../../../workspace.js';

/**
 * The directory backing a Space.
 *
 * Resolved through {@link canvasDirName} rather than the canvasId, because
 * Disk files a Space under its title and that name moves on rename. This is
 * also the materialization anchor the rest of the app reaches by way of the
 * Space handle's `diskTree` member.
 */
export function canvasRoot(canvasId: string): string {
  const safeId = sanitizeId(canvasId, 'canvasId');
  const workspaceRoot = path.resolve(getWorkspacePath());
  const resolved = path.resolve(workspaceRoot, canvasDirName(safeId));
  if (!resolved.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new Error(`Canvas path escapes the active Workspace: "${canvasId}"`);
  }
  return resolved;
}

/**
 * On-disk topology filename. Agent- and user-visible (L1), so it uses the
 * Space vocabulary; the TypeScript type of its contents stays `CanvasFile`
 * (L2 internal). See migrate-canvas-to-space.ts for the legacy rename.
 */
export const SPACE_JSON_FILENAME = 'space.json';
export const WORLD_CANVAS_DIR_NAME = '.world';

export function canvasJsonPath(canvasId: string): string {
  return path.join(canvasRoot(canvasId), SPACE_JSON_FILENAME);
}

export function nodesDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'nodes');
}

export function nodeFilePath(canvasId: string, filename: string): string {
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid node filename: "${filename}"`);
  }
  return path.join(nodesDir(canvasId), base);
}

/** Hidden directory holding raw uploaded files keyed by artifactId. */
export const ARTIFACTS_DIR_NAME = '.artifacts';

export function artifactsDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), ARTIFACTS_DIR_NAME);
}

export function artifactPath(canvasId: string, filename: string): string {
  const base = path.basename(filename);
  if (!base || base === '.' || base === '..') {
    throw new Error(`Invalid artifact filename: "${filename}"`);
  }
  return path.join(artifactsDir(canvasId), base);
}

/**
 * The hidden per-Space tier. Shared with non-storage owners today; see the
 * module note above and §12.5.3.
 */
export const HISTORY_DIR_NAME = '.history';

export function historyDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), HISTORY_DIR_NAME);
}

export function chatDir(canvasId: string): string {
  return path.join(historyDir(canvasId), 'chat');
}

/**
 * Pending change-review records for an ACP thread (the "what the agent
 * changed" card). A mutable sidecar — entries are removed on accept /
 * revert — so it lives apart from the append-only `.turns.jsonl` log.
 */
export function changesPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.changes.json`,
  );
}

export function tasksPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'tasks.json');
}

export function eventsPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'events.jsonl');
}

/**
 * Append-only delta log for headless executor batches (M2).
 *
 * One JSONL line per `POST /api/canvas/:canvasId/execute` call that
 * actually mutated state. Lines carry the canvas version, run id,
 * originator, applied commands, and the resulting structural deltas
 * (see `shared/canvas-engine/delta.ts`). Used by M3 broadcast / replay
 * and as the persistence anchor for `space.json`'s monotonic version
 * counter.
 *
 * Lives next to `events.jsonl` so the entire `.history/` tier travels
 * together in canvas export bundles.
 */
export function deltaLogPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'delta-log.jsonl');
}
