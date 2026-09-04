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
 *   - Per-Space state owned by *another* domain — ACP sessions, now the only
 *     one — which needs a materialized directory but not the Disk record
 *     layout. It anchors on the Space's Disk tree from the storage facade, so
 *     it no longer consults the Disk name index (§12.5.4).
 *
 * Three families have already left. Memory-worker bookkeeping and the debug
 * prompt log build their own stores on the storage extension substrate
 * (§6.4.4), which is a place rather than a path; the Space memory body is a
 * blob under the Space's own scope (§6.4.3, disposition D), so neither its
 * placement nor its name is named here any more. ACP sessions leave with
 * phase 6.
 *
 * The Disk record and blob layout moved to `storage/backends/disk/layout.ts`.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-Space
 *     user.md                       user memory (preferences)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <spaceDir>/
 *     .history/
 *       acp-sessions.json           per-thread ACP sessionId map (optional)
 *
 * Naming convention: anything prefixed with `.` is hidden / AI-private;
 * anything without the prefix is user-visible.
 */

import path from 'node:path';

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
 * The one family left here is ACP sessions, which phase 6 relocates with the
 * Agenetes `Namespace` change (proposal §6.4.3). Until then it is a bare
 * file, and this branch says once what its callers would otherwise repeat:
 * these paths exist only where the backend has a tree.
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
// One scope left: user memory (`<workspace>/setting/user.md`), the
// cross-Space, user-editable preferences file. A Space's own AI-private body
// is a blob the storage facade places, not a path this module builds.

/** Workspace memory — cross-canvas user preferences: `<workspace>/setting/user.md`. */
export function workspaceMemoryPath(): string {
  return path.join(settingDir(), 'user.md');
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
