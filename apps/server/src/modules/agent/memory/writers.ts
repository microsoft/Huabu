/**
 * Stub memory writers (PR-C).
 *
 * In PR-C every writer is dry-run only: it sandbox-validates the
 * target path, logs what it would do, and returns success. No file
 * is touched, no cache is invalidated. PR-D replaces the bodies with
 * real read-merge-write logic + auto-compaction.
 *
 * The function signatures here are the **stable contract** the
 * memory sub-agent and its tool definitions code against, so PR-D
 * only has to change the bodies.
 */

import {
  resolveLongTermPath,
  resolveUserSkillPath,
  resolveWorkingMemoryPath,
  MemorySandboxError,
} from './sandbox.js';

import type { MemoryLogger } from './index.js';

export interface WriteResult {
  ok: boolean;
  /** Absolute path the writer targeted (resolved through the sandbox). */
  target: string;
  /** Short, agent-readable reason — populated on both success and reject. */
  reason: string;
}

/**
 * Long-term memory writer — `<workspace>/setting/.huabu.md`.
 *
 * `mode === 'patch'` is the only accepted operation: PR-D will
 * implement bullet-level diff merge with dedup and a 4 KB / 80-line
 * auto-compaction trigger. `mode === 'replace'` is reserved for the
 * future consolidate path; rejected here so the agent does not
 * accidentally nuke user-edited prose during the stub phase.
 */
export function writeLongTerm(args: {
  mode: 'patch' | 'replace';
  diff: string;
  logger?: MemoryLogger;
}): WriteResult {
  try {
    const target = resolveLongTermPath();
    if (args.mode !== 'patch') {
      return {
        ok: false,
        target,
        reason: `long-term writer only accepts mode="patch" in this phase`,
      };
    }
    args.logger?.info(
      `[memory] (dry-run) would patch long-term memory at ${target} with ${args.diff.length} chars of diff`,
    );
    return { ok: true, target, reason: 'dry-run: not persisted' };
  } catch (err) {
    return rejectFromError(err, '<unresolved>');
  }
}

/**
 * Working-memory writer — `<canvasDir>/.memory/canvas.md`.
 *
 * Body is replaced verbatim; PR-D adds size-based auto-compaction.
 */
export function writeWorkingMemory(args: {
  canvasId: string;
  body: string;
  logger?: MemoryLogger;
}): WriteResult {
  try {
    const target = resolveWorkingMemoryPath(args.canvasId);
    args.logger?.info(
      `[memory] (dry-run) would replace working memory at ${target} with ${args.body.length} chars`,
    );
    return { ok: true, target, reason: 'dry-run: not persisted' };
  } catch (err) {
    return rejectFromError(err, '<unresolved>');
  }
}

/**
 * Skill writer — `<workspace>/setting/skills/<id>/SKILL.md`.
 *
 * Strict create-vs-update semantics enforced even in the stub phase
 * so the contract is testable:
 *   - `op === 'create'`  requires a non-trivial `rationale`
 *     (>= 20 chars) so the LLM has to justify why an existing
 *     skill could not be updated instead.
 *   - `op === 'update'`  has no rationale requirement; PR-D will
 *     read the existing body and merge.
 *
 * Frontmatter fields beyond `id` are passed through but not validated
 * at this layer — the loader's `validateFrontmatter` will catch
 * structural problems on the next `listSkills` call. PR-D will pre-
 * validate so a bad write is rejected before touching disk.
 */
export function writeSkill(args: {
  op: 'create' | 'update';
  id: string;
  title?: string;
  body: string;
  rationale?: string;
  appliesTo?: string[];
  logger?: MemoryLogger;
}): WriteResult {
  try {
    const target = resolveUserSkillPath(args.id);
    if (args.op === 'create') {
      const r = args.rationale?.trim() ?? '';
      if (r.length < 20) {
        return {
          ok: false,
          target,
          reason:
            'skill create rejected: provide a rationale (>= 20 chars) explaining why an existing skill cannot be updated',
        };
      }
    }
    args.logger?.info(
      `[memory] (dry-run) would ${args.op} skill "${args.id}" at ${target} (body ${args.body.length} chars)`,
    );
    return { ok: true, target, reason: 'dry-run: not persisted' };
  } catch (err) {
    return rejectFromError(err, '<unresolved>');
  }
}

function rejectFromError(err: unknown, target: string): WriteResult {
  if (err instanceof MemorySandboxError) {
    return { ok: false, target, reason: err.message };
  }
  return { ok: false, target, reason: (err as Error).message };
}
