/**
 * Storage paths.
 *
 * Layout under `<workspace>/`:
 *
 *   setting/                        user-owned, cross-canvas
 *     .huabu.md                     long-term memory (PR-B)
 *     skills/<id>/SKILL.md          user / memory-agent authored skills
 *   <canvasDir>/                    name = sanitised canvas title
 *     canvas.json                   carries the stable canvasId
 *     nodes/<safe(label)>.md        per-node markdown (id in frontmatter)
 *     .artifacts/<artifactId><ext>  raw uploads (hidden dir)
 *     memory/preferences.md
 *     .history/
 *       chat/<threadId>.json        pi-ai Context (messages, append-only)
 *       chat/<threadId>.parts.json  rich-ACP sidecar overlay (optional)
 *       intent.json
 *       events.jsonl
 *       acp-sessions.json           per-thread ACP sessionId map (optional)
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

export function memoryDir(canvasId: string): string {
  return path.join(canvasRoot(canvasId), 'memory');
}

export function prefsPath(canvasId: string): string {
  return path.join(memoryDir(canvasId), 'preferences.md');
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
