/**
 * Filesystem sandbox for the memory module.
 *
 * Two roots, both legitimate targets for the three memory writers:
 *
 *   - **Workspace root** (`<workspace>/setting/`) — workspace memory
 *     (`user.md`) and user-skill SKILL.md files.
 *   - **Canvas root** (`<canvasDir>/.memory/`) — canvas memory body
 *     (`canvas.md`) and the worker's `state.json`.
 *
 * Everything else is rejected. Each writer goes through
 * {@link resolveLongTermPath} / {@link resolveUserSkillPath} /
 * {@link resolveWorkingMemoryPath} so the security model lives in one
 * place — same posture as the chat sandbox at
 * `modules/agent/tools/handlers/fs-sandbox.ts`.
 *
 * Path-traversal defence: every resolver does a strict prefix check
 * (`path.resolve` → must be `root` exactly or start with `root + sep`)
 * so a `..` segment or an absolute override cannot escape the allowed
 * root.
 */

import path from 'node:path';

import {
  workspaceMemoryPath,
  settingDir,
  userSkillsDir,
  canvasMemoryDir,
  canvasMemoryPath,
} from '../../storage/paths.js';

/** Thrown by every resolver below on out-of-sandbox attempts. */
export class MemorySandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemorySandboxError';
  }
}

/** Reject empty / non-string ids and any id with path separators. */
function validateSkillId(id: unknown): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new MemorySandboxError('skill id is required');
  }
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
    throw new MemorySandboxError(`invalid skill id: ${id}`);
  }
  // Keep ids file-system safe across platforms. Matches the convention
  // used by the chat sandbox's `sanitizeId` (which is too strict for
  // arbitrary skill ids — we allow more characters here but still
  // exclude separators / control bytes).
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"|?*]/.test(id)) {
    throw new MemorySandboxError(`invalid skill id: ${id}`);
  }
  return id;
}

/** Strict prefix check helper shared by every resolver below. */
function ensureUnderRoot(root: string, candidate: string, label: string): void {
  if (candidate === root) return;
  if (candidate.startsWith(root + path.sep)) return;
  throw new MemorySandboxError(
    `path escapes the ${label} sandbox: ${candidate}`,
  );
}

/**
 * Resolve the canonical absolute path of the workspace memory file.
 *
 * No segments parameter: there is exactly one workspace memory file
 * per workspace. The function exists purely so callers go through the
 * same sandbox-enforcing surface as the other writers, and so the
 * setting/ root is materialised consistently.
 */
export function resolveLongTermPath(): string {
  const root = settingDir();
  const target = workspaceMemoryPath();
  ensureUnderRoot(root, target, 'workspace setting');
  return target;
}

/**
 * Resolve the absolute SKILL.md path for a user skill by id.
 *
 * `<workspace>/setting/skills/<id>/SKILL.md`. Throws on traversal /
 * separator chars / control bytes.
 */
export function resolveUserSkillPath(id: string): string {
  const safeId = validateSkillId(id);
  const root = userSkillsDir();
  const target = path.resolve(root, safeId, 'SKILL.md');
  ensureUnderRoot(root, target, 'user skills');
  return target;
}

/**
 * Resolve the absolute Space memory file path. Throws if the resolved path
 * escapes the canvas's `.memory/` root (a defensive check — the path
 * computation in `workspace/disk/paths.ts` already constrains the result,
 * but going through `ensureUnderRoot` keeps the invariant explicit).
 */
export function resolveWorkingMemoryPath(canvasId: string): string {
  const root = canvasMemoryDir(canvasId);
  const target = canvasMemoryPath(canvasId);
  ensureUnderRoot(root, target, 'canvas memory');
  return target;
}
