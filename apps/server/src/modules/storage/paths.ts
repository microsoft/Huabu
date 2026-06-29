/**
 * Storage paths.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-canvas
 *     .huabu.md                     workspace memory (user preferences)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <canvasDir>/                    name = sanitised canvas title
 *     canvas.json                   carries the stable canvasId
 *     nodes/<safe(label)>.md        per-node markdown (id in frontmatter)
 *     .artifacts/<artifactId><ext>  raw uploads (hidden dir)
 *     .memory/                      canvas-scoped canvas memory (AI-private)
 *       canvas.md                   canvas memory body
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
 * Do not use in new code — the active path is {@link canvasMemoryDir}.
 */
export function memoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'memory');
}

/**
 * @deprecated See {@link memoryDir}. The current canvas memory path
 * is {@link canvasMemoryPath}.
 */
export function prefsPath(canvasId: string): string {
  return path.join(memoryDir(canvasId), 'preferences.md');
}

// ─── Memory module paths ───────────────────────────────────────────────────
//
// Two scopes:
//   - Workspace memory (`<workspace>/setting/.huabu.md`):
//     cross-canvas user preferences / profile. User-editable.
//   - Canvas-level canvas memory (`<canvasDir>/.memory/`): hidden,
//     AI-private working notes for *this* canvas. The leading `.` puts
//     it in the same hidden tier as `.history/` and `.artifacts/`.

/** Workspace memory — cross-canvas user preferences: `<workspace>/setting/.huabu.md`. */
export function workspaceMemoryPath(): string {
  return path.join(settingDir(), '.huabu.md');
}

/** Hidden directory holding canvas-scoped canvas memory + bookkeeping. */
export const WORKING_MEMORY_DIR_NAME = '.memory';

export function canvasMemoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), WORKING_MEMORY_DIR_NAME);
}

/** Working memory body for a canvas. */
export function canvasMemoryPath(canvasId: string): string {
  return path.join(canvasMemoryDir(canvasId), 'canvas.md');
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
 * Workspace-level user setting directory: `<workspace>/setting/`.
 * Holds cross-canvas, user-visible artifacts:
 *   - `.huabu.md`            workspace user memory (PR-B)
 *   - `skills/<id>/SKILL.md` user-authored / memory-agent-authored skills
 *
 * Distinct from the per-canvas `memory/` directory (which is
 * canvas-scoped canvas memory, AI-private). This one is the
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
 * Structured thread record paired with a thread — the source of truth
 * for chat history in the envelope-persistence model. An append-only
 * JSONL log of finalized turns, each carrying the user's structured
 * {@link ChatEnvelope} plus the assistant/tool transcript it produced.
 * Kept on a distinct `.turns.jsonl` path so legacy `.json` pi-ai
 * `Context` files are simply ignored (no migration). See
 * `chat-thread-store.ts` for the schema.
 */
export function chatTurnsPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.turns.jsonl`,
  );
}

/**
 * The single in-progress turn for a thread, rewritten on each debounced
 * save during streaming so a mid-generation reload still shows partial
 * progress. Promoted to a `.turns.jsonl` line (and deleted) when the
 * turn finalizes. See `chat-thread-store.ts`.
 */
export function chatActiveTurnPath(canvasId: string, threadId: string): string {
  return path.join(
    chatDir(canvasId),
    `${sanitizeId(threadId, 'threadId')}.active.json`,
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
 * and as the persistence anchor for `canvas.json`'s monotonic version
 * counter.
 *
 * Lives next to `events.jsonl` so the entire `.history/` tier travels
 * together in canvas export bundles.
 */
export function deltaLogPath(canvasId: string): string {
  return path.join(historyDir(canvasId), 'delta-log.jsonl');
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
