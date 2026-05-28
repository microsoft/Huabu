/**
 * Storage paths.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-canvas
 *     .huabu.md                     long-term memory (user preferences)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <canvasDir>/                    name = sanitised canvas title
 *     canvas.json                   carries the stable canvasId
 *     nodes/<safe(label)>.md        per-node markdown (id in frontmatter)
 *     .artifacts/<artifactId><ext>  raw uploads (hidden dir)
 *     .memory/                      canvas-scoped working memory (AI-private)
 *       canvas.md                   short-term working memory body
 *       state.json                  memory worker bookkeeping
 *     .history/
 *       chat/<threadId>.json        pi-ai Context (messages, append-only)
 *       chat/<threadId>.parts.json  rich-ACP sidecar overlay (optional)
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
import { sanitizeId } from './io.js';
import { getWorkspacePath } from '../workspace.js';

export function canvasRoot(canvasId: string): string {
  const safeId = sanitizeId(canvasId, 'canvasId');
  return path.join(getWorkspacePath(), canvasDirName(safeId));
}

export function canvasJsonPath(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'canvas.json');
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
 * @deprecated Legacy V0 memory directory (`<canvasDir>/memory/`).
 * Retained only so the one-shot {@link import('./migrate-memory.js').migrateLegacyMemory}
 * pass can find old `preferences.md` files and mv them into `.memory/canvas.md`.
 * Do not use in new code — the active path is {@link workingMemoryDir}.
 */
export function memoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'memory');
}

/**
 * @deprecated See {@link memoryDir}. The current short-term memory path
 * is {@link workingMemoryPath}.
 */
export function prefsPath(canvasId: string): string {
  return path.join(memoryDir(canvasId), 'preferences.md');
}

// ─── Memory module paths ───────────────────────────────────────────────────
//
// Two scopes:
//   - Workspace-level long-term memory (`<workspace>/setting/.huabu.md`):
//     cross-canvas user preferences / profile. User-editable.
//   - Canvas-level working memory (`<canvasDir>/.memory/`): hidden,
//     AI-private working notes for *this* canvas. The leading `.` puts
//     it in the same hidden tier as `.history/` and `.artifacts/`.

/** Long-term, cross-canvas user preferences: `<workspace>/setting/.huabu.md`. */
export function longTermMemoryPath(): string {
  return path.join(settingDir(), '.huabu.md');
}

/** Hidden directory holding canvas-scoped working memory + bookkeeping. */
export const WORKING_MEMORY_DIR_NAME = '.memory';

export function workingMemoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), WORKING_MEMORY_DIR_NAME);
}

/** Short-term working memory body for a canvas. */
export function workingMemoryPath(canvasId: string): string {
  return path.join(workingMemoryDir(canvasId), 'canvas.md');
}

/**
 * Bookkeeping JSON for the memory worker, per canvas:
 *   `{ counter, lastAnalyzedAt, lastSeenThreadCursor }`
 *
 * Read/written by `modules/agent/memory/trigger.ts` (PR-B/C).
 */
export function memoryStatePath(canvasId: string): string {
  return path.join(workingMemoryDir(canvasId), 'state.json');
}

// ─── Workspace-level setting / user skills ─────────────────────────────────

/**
 * Workspace-level user setting directory: `<workspace>/setting/`.
 * Holds cross-canvas, user-visible artifacts:
 *   - `.huabu.md`            long-term user memory (PR-B)
 *   - `skills/<id>/SKILL.md` user-authored / memory-agent-authored skills
 *
 * Distinct from the per-canvas `memory/` directory (which is
 * canvas-scoped working memory, AI-private). This one is the
 * cross-canvas, user-editable surface.
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

export function chatPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.json`,
  );
}

/**
 * Sidecar JSON paired with `chatPath` — holds rich-ACP overlay parts
 * (plan entries, tool-call extension fields, permission outcomes)
 * that don't fit inside the pi-ai `Context` shape. See
 * `chat-parts-store.ts` for the schema. Optional: a thread without
 * ACP enrichment simply has no `.parts.json` file.
 */
export function chatPartsPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.parts.json`,
  );
}

export function intentPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'intent.json');
}

export function eventsPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'events.jsonl');
}

/**
 * ACP session persistence — maps each Sediment thread on this canvas
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
