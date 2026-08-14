// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `fs_write` tool handler — single write entry point for the agent.
 *
 * The agent only sees one writer tool: `fs_write({ path, mode, ... })`.
 * This handler is the path-aware router that:
 *
 *   1. Resolves the virtual `path` through the memory sandbox
 *      ({@link ../../memory/sandbox.ts}) to an absolute path. Only
 *      three virtual paths are accepted; everything else is rejected
 *      so the agent gets a clear error rather than a silent miss.
 *   2. Validates the mode-specific arguments (no Type-level union —
 *      we keep the schema flat so the LLM only ever sees the simple
 *      "give me a path + a mode + fields" shape).
 *   3. Enforces the one and only conditionally-required field: a
 *      `rationale` (≥ {@link SKILL_CREATE_RATIONALE_MIN} chars) when
 *      creating a brand-new user skill — the "skills are precious"
 *      rule from `prompt/agents/memory/AGENT.md`.
 *   4. Delegates to the matching writer in
 *      {@link ../../memory/writers.ts}. Writers never throw — they
 *      return a structured {@link WriteResult}.
 *
 * Mirrors the read side: `read({ path: 'memory/workspace.md' | ... })`
 * already accepts these same virtual paths. The two halves stay
 * symmetrical so the agent's mental model is just "files at known
 * paths" — no `memory_*_write` zoo.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { normalizeRel } from './fs-sandbox.js';
import {
  canvasMemoryDir,
  settingDir,
  userSkillsDir,
} from '../../../workspace/paths.js';
import {
  resolveLongTermPath,
  resolveUserSkillPath,
  resolveWorkingMemoryPath,
} from '../../memory/sandbox.js';
import {
  overwriteMemoryFile,
  replaceStringInMemoryFile,
  SKILL_CREATE_RATIONALE_MIN,
  type MemoryTier,
  type WriteResult,
} from '../../memory/writers.js';

import type { fsWriteParamsSchema } from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────

export type FsWriteArgs = Static<typeof fsWriteParamsSchema> & {
  /**
   * Injected by the executor from the request-scoped canvas id.
   * Required for the canvas-memory path; optional otherwise.
   */
  canvasId?: string;
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleFsWrite(args: FsWriteArgs): Promise<string> {
  const target = resolveTarget(args);
  if ('error' in target) return reject(target.path, target.error);

  if (args.mode === 'overwrite') {
    return handleOverwrite(args, target);
  }
  if (args.mode === 'replace_string') {
    return handleReplaceString(args, target);
  }
  // `mode` is schema-constrained, but keep the exhaustive branch so a
  // future literal added to the schema produces a clear runtime error
  // until the dispatcher is updated.
  return reject(
    target.absPath,
    `unknown mode: ${(args as { mode?: string }).mode ?? '(missing)'}`,
  );
}

// ─── Path routing ──────────────────────────────────────────────────────────

interface ResolvedTarget {
  tier: MemoryTier;
  absPath: string;
  parentDir: string;
  skillId?: string;
  /** The normalised relative path, for error messages. */
  path: string;
}

function resolveTarget(
  args: FsWriteArgs,
): ResolvedTarget | { path: string; error: string } {
  if (typeof args.path !== 'string' || args.path.length === 0) {
    return { path: '<missing>', error: 'path is required' };
  }
  const rel = normalizeRel(args.path);

  if (rel === 'memory/user.md') {
    return {
      tier: 'workspace',
      absPath: resolveLongTermPath(),
      parentDir: settingDir(),
      path: rel,
    };
  }

  if (rel === 'memory/space.md') {
    if (!args.canvasId) {
      return {
        path: rel,
        error:
          'memory/space.md is Space-scoped but no canvasId is bound to this request',
      };
    }
    return {
      tier: 'canvas',
      absPath: resolveWorkingMemoryPath(args.canvasId),
      parentDir: canvasMemoryDir(args.canvasId),
      path: rel,
    };
  }

  if (rel.startsWith('skills/') && rel.endsWith('/SKILL.md')) {
    const segs = rel.split('/');
    // Must be exactly `skills/<id>/SKILL.md` — no nested ids, no
    // siblings. `resolveUserSkillPath` enforces the FS-safety of
    // `<id>` itself (throws MemorySandboxError on traversal /
    // separators / control bytes); we re-wrap that into the standard
    // reject envelope below.
    if (segs.length !== 3 || segs[1].length === 0) {
      return {
        path: rel,
        error: `fs_write only accepts skill paths of the form "skills/<id>/SKILL.md"`,
      };
    }
    const skillId = segs[1];
    try {
      const absPath = resolveUserSkillPath(skillId);
      return {
        tier: 'skill',
        absPath,
        parentDir: path.dirname(absPath),
        skillId,
        path: rel,
      };
    } catch (err) {
      return { path: rel, error: (err as Error).message };
    }
  }

  return {
    path: rel,
    error: `fs_write: unsupported path "${rel}". Allowed: memory/user.md, memory/space.md, skills/<id>/SKILL.md`,
  };
}

// ─── Mode handlers ─────────────────────────────────────────────────────────

async function handleOverwrite(
  args: FsWriteArgs,
  target: ResolvedTarget,
): Promise<string> {
  if (typeof args.body !== 'string') {
    return reject(target.absPath, 'mode="overwrite" requires "body"');
  }

  // Skill create rule: when the target file does not yet exist on a
  // `skills/` path, the agent is creating a brand-new skill. The
  // memory curator AGENT.md treats this as a precious action — we
  // hard-require a rationale (≥ N chars) here so the LLM cannot
  // sneak a new skill in without justifying why an existing one
  // could not be edited.
  if (target.tier === 'skill' && !existsSync(target.absPath)) {
    const r = (args.rationale ?? '').trim();
    if (r.length < SKILL_CREATE_RATIONALE_MIN) {
      return reject(
        target.absPath,
        `skill create rejected: provide a "rationale" (>= ${SKILL_CREATE_RATIONALE_MIN} chars) explaining why no existing skill can be updated`,
      );
    }
    // Defensive: ensure the parent directory under setting/skills/
    // exists even before the writer's mkdirp runs, so a malformed
    // resolveUserSkillPath result surfaces as a clear error here
    // rather than mid-write.
    if (!target.parentDir.startsWith(userSkillsDir())) {
      return reject(
        target.absPath,
        'skill target escapes the user skills sandbox',
      );
    }
  }

  const result = await overwriteMemoryFile({
    tier: target.tier,
    absPath: target.absPath,
    parentDir: target.parentDir,
    skillId: target.skillId,
    body: args.body,
  });
  return JSON.stringify(result);
}

async function handleReplaceString(
  args: FsWriteArgs,
  target: ResolvedTarget,
): Promise<string> {
  if (typeof args.oldString !== 'string') {
    return reject(target.absPath, 'mode="replace_string" requires "oldString"');
  }
  if (typeof args.newString !== 'string') {
    return reject(target.absPath, 'mode="replace_string" requires "newString"');
  }
  const result = await replaceStringInMemoryFile({
    tier: target.tier,
    absPath: target.absPath,
    parentDir: target.parentDir,
    skillId: target.skillId,
    oldString: args.oldString,
    newString: args.newString,
  });
  return JSON.stringify(result);
}

// ─── Reject helper ─────────────────────────────────────────────────────────

function reject(target: string, reason: string): string {
  const r: WriteResult = { ok: false, target, reason };
  return JSON.stringify(r);
}
