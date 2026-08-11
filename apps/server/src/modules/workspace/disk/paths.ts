// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Storage paths.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-Space
 *     user.md                       user memory (preferences)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <canvasDir>/                    name = sanitised Space title
 *     space.json                    carries the stable canvasId
 *     nodes/<safe(label)>.md        per-node markdown (id in frontmatter)
 *     .artifacts/<artifactId><ext>  raw uploads (hidden dir)
 *     .memory/                      Space-scoped memory (AI-private)
 *       space.md                    Space memory body
 *       state.json                  memory worker bookkeeping
 *     .history/
 *       chat/<threadId>.turns.jsonl finalized turns (append-only)
 *       chat/<threadId>.active.json in-progress turn (partial)
 *       intent.json
 *       events.jsonl
 *       acp-sessions.json           per-thread ACP sessionId map (optional)
 *
 * Naming convention: anything prefixed with `.` is hidden / AI-private
 * (`.artifacts`, `.history`, `.memory`); anything without the prefix is
 * user-visible (`nodes/`, `setting/`).
 */

import path from 'node:path';

import { canvasDirName } from './canvas-dirs.js';
import { sanitizeId } from '../../../utils/fs.js';
import { getWorkspacePath } from '../../workspace.js';

import type { Namespace } from '@agenetes/protocol';

/** Workspace-owned metadata that must never be mistaken for a Space. */
export const HUABU_WORKSPACE_METADATA_DIR_NAME = '.huabu';

/** Root for Workspace-owned metadata used by storage recovery. */
export function workspaceHuabuDir(workspacePath: string): string {
  return path.join(
    path.resolve(workspacePath),
    HUABU_WORKSPACE_METADATA_DIR_NAME,
  );
}

/** Prepared/committed Disk structured-storage transaction journals. */
export function workspaceTransactionsDir(workspacePath: string): string {
  return path.join(workspaceHuabuDir(workspacePath), 'transactions');
}

/** Durable Disk node tombstones (introduced by structured-storage Phase 4). */
export function workspaceTombstonesDir(workspacePath: string): string {
  return path.join(workspaceHuabuDir(workspacePath), 'tombstones');
}

export function canvasRoot(canvasId: string): string {
  const safeId = sanitizeId(canvasId, 'canvasId');
  return path.join(getWorkspacePath(), canvasDirName(safeId));
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

// ─── Memory module paths ───────────────────────────────────────────────────
//
// Two scopes:
//   - User memory (`<workspace>/setting/user.md`):
//     cross-Space user preferences / profile. User-editable.
//   - Space memory (`<canvasDir>/.memory/`): hidden,
//     AI-private working notes for *this* Space. The leading `.` puts
//     it in the same hidden tier as `.history/` and `.artifacts/`.

/** Workspace memory — cross-canvas user preferences: `<workspace>/setting/user.md`. */
export function workspaceMemoryPath(): string {
  return path.join(settingDir(), 'user.md');
}

/** Hidden directory holding canvas-scoped canvas memory + bookkeeping. */
export const WORKING_MEMORY_DIR_NAME = '.memory';

export function canvasMemoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), WORKING_MEMORY_DIR_NAME);
}

/** Working memory body for a canvas. */
export function canvasMemoryPath(canvasId: string): string {
  return path.join(canvasMemoryDir(canvasId), 'space.md');
}

/**
 * Bookkeeping JSON for the memory worker, per canvas:
 *   `{ counter, lastAnalyzedAt, lastSeenThreadCursor }`
 *
 * Read/written by `modules/agent/memory/trigger.ts` (PR-B/C).
 */
export function memoryStatePath(canvasId: string): string {
  return path.join(canvasMemoryDir(canvasId), 'state.json');
}

// ─── Workspace-level setting / user skills ─────────────────────────────────

/**
 * Home-level user setting directory: `<workspace>/setting/`.
 * Holds cross-Space, user-visible artifacts:
 *   - `user.md`              user memory
 *   - `skills/<id>/SKILL.md` user-authored / memory-agent-authored skills
 *
 * Distinct from the per-Space `.memory/` directory (which is AI-private).
 * This one is the cross-Space, user-editable surface.
 */
export function settingDir(): string {
  return path.join(getWorkspacePath(), 'setting');
}

/** User skill root: `<workspace>/setting/skills/`. */
export function userSkillsDir(): string {
  return path.join(settingDir(), 'skills');
}

export function historyDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), '.history');
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

/**
 * Human-readable debug dump of the assembled prompt sent to the agent,
 * one block per turn with strong turn separators. Append-only, written
 * only when the `HUABU_DEBUG_PROMPT` env flag is set. Never read by the
 * app — purely a developer post-mortem aid. See `conversation/prompt/debug-prompt.ts`.
 */
export function chatPromptLogPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.prompt.log`,
  );
}

export function intentPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'intent.json');
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

/**
 * ACP session persistence — maps each Huabu thread on this canvas
 * to the live ACP `sessionId` returned by `session/new`, so we can
 * call `session/load` after a server restart instead of opening a
 * fresh session (which would lose the external agent's memory).
 *
 * One JSON file per canvas; see `agent/acp/session-store.ts` for the
 * record shape. Absence of the file = no persisted sessions for this
 * canvas, which is the default for any canvas that has never bound
 * an external agent.
 */
export function acpSessionsPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'acp-sessions.json');
}

/**
 * The Agenetes {@link Namespace} (L2 storage/metadata scope) for a
 * canvas's ACP session store. `canvasId` is Huabu's de-facto namespace
 * key; `storage.root` is the canvas history dir, so the driver's store
 * persists `<storage.root>/acp-sessions.json` — byte-for-byte the same file
 * {@link acpSessionsPath} names today. Empty `canvasId` yields a name-less
 * namespace the store treats as non-persistent (mirrors the previous
 * empty-canvasId no-op). See docs/proposals/layered-architecture.md §7 M5.0.
 */
export function canvasAcpNamespace(canvasId: string): Namespace {
  return {
    name: canvasId,
    storage: canvasId ? { root: historyDir(canvasId) } : undefined,
  };
}
