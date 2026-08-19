// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Workspace paths that outlive the storage backend.
 *
 * What remains here passes the §12.5.2 test: it is still meaningful once the
 * structured backend keeps Spaces in tables. Two populations qualify.
 *
 *   - Workspace-level, no canvasId: `setting/` and the user memory file.
 *     Untouched by a backend switch.
 *   - Per-Space state owned by *other* domains — memory, ACP sessions, the
 *     debug prompt log — which need a materialized directory but not the Disk
 *     record layout. They anchor on the Space's Disk tree from the storage
 *     facade, so they no longer consult the Disk name index (§12.5.4).
 *
 * The Disk record and blob layout moved to `storage/backends/disk/layout.ts`.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-Space
 *     user.md                       user memory (preferences)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <spaceDir>/
 *     .memory/                      Space-scoped memory (AI-private)
 *       space.md                    Space memory body
 *       state.json                  memory worker bookkeeping
 *     .history/
 *       acp-sessions.json           per-thread ACP sessionId map (optional)
 *       chat/<threadId>.prompt.log  debug dump, opt-in
 *
 * Naming convention: anything prefixed with `.` is hidden / AI-private;
 * anything without the prefix is user-visible.
 */

import path from 'node:path';

import { sanitizeId } from '../../utils/fs.js';
import { space } from '../storage/index.js';
import { getWorkspacePath } from '../workspace.js';

import type { Namespace } from '@agenetes/protocol';

/**
 * The `.history/` tier is named by the Disk backend, which owns most of what
 * is in it. The families below sit there only because they were written next
 * to it; the duplicated literal keeps that colocation visible as the accident
 * it is, rather than binding this module to the backend's layout (§12.5.3).
 */
const LEGACY_HISTORY_DIR_NAME = '.history';

/**
 * The Space's real directory, or a refusal.
 *
 * Every path this module builds is for a family Phase 4.6 relocates — memory
 * state and the debug prompt log to the extension substrate, the memory body
 * to a blob, ACP sessions with phase 6 (proposal §6.4.3). Until then they are
 * bare files, so one branch here says once what each of them would otherwise
 * repeat: these paths exist only where the backend has a tree.
 */
function spaceRoot(canvasId: string): string {
  const tree = space(canvasId).diskTree;
  if (!tree) {
    throw new Error(
      `Per-Space files for "${canvasId}" need a Space directory, which the ` +
        'active structured backend does not provide.',
    );
  }
  return tree.directory();
}

function legacyHistoryDir(canvasId: string): string {
  return path.join(spaceRoot(canvasId), LEGACY_HISTORY_DIR_NAME);
}

// ─── Memory module paths ───────────────────────────────────────────────────
//
// Two scopes:
//   - User memory (`<workspace>/setting/user.md`):
//     cross-Space user preferences / profile. User-editable.
//   - Space memory (`<spaceDir>/.memory/`): hidden,
//     AI-private working notes for *this* Space. The leading `.` puts
//     it in the same hidden tier as `.history/` and `.artifacts/`.

/** Workspace memory — cross-canvas user preferences: `<workspace>/setting/user.md`. */
export function workspaceMemoryPath(): string {
  return path.join(settingDir(), 'user.md');
}

/** Hidden directory holding canvas-scoped canvas memory + bookkeeping. */
export const WORKING_MEMORY_DIR_NAME = '.memory';

export function canvasMemoryDir(canvasId: string): string {
  return path.join(spaceRoot(canvasId), WORKING_MEMORY_DIR_NAME);
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

/**
 * Human-readable debug dump of the assembled prompt sent to the agent,
 * one block per turn with strong turn separators. Append-only, written
 * only when the `HUABU_DEBUG_PROMPT` env flag is set. Never read by the
 * app — purely a developer post-mortem aid. See `conversation/prompt/debug-prompt.ts`.
 */
export function chatPromptLogPath(canvasId: string, threadId: string): string {
  return path.join(
    legacyHistoryDir(canvasId),
    'chat',
    `${sanitizeId(threadId, 'threadId')}.prompt.log`,
  );
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
  return path.join(legacyHistoryDir(canvasId), 'acp-sessions.json');
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
    storage: canvasId ? { root: legacyHistoryDir(canvasId) } : undefined,
  };
}
