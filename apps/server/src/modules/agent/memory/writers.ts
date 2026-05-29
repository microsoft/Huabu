/**
 * Memory writers — real file I/O (PR-D).
 *
 * Each writer is the single point where one memory file gets mutated.
 * They all:
 *
 *   1. Resolve the target path through the sandbox
 *      ({@link ./sandbox.ts}). Path traversal / invalid id rejection
 *      surfaces as `ok:false` with the sandbox error message.
 *   2. Enforce the size cap (4 KB / 80 lines) for the prose memories.
 *      Oversize input is rejected — the sub-agent's prompt instructs
 *      it to stay terse; an LLM-driven re-summarisation loop is a
 *      follow-up.
 *   3. Read existing content (when relevant), merge, and atomically
 *      write the result.
 *   4. For skills, call {@link invalidateUserSkill} so the next agent
 *      `read("skills/<id>/SKILL.md")` sees the new content without
 *      waiting on the 2-second TTL.
 *
 * Failures never throw past the sandbox boundary — every writer
 * returns a structured {@link WriteResult} so the sub-agent (and the
 * worker's summary log) can reason about partial success.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  MemorySandboxError,
  resolveLongTermPath,
  resolveUserSkillPath,
  resolveWorkingMemoryPath,
} from './sandbox.js';
import { invalidateUserSkill } from '../../../prompt/index.js';
import { parseFrontmatter } from '../../storage/frontmatter.js';
import { atomicWriteText, mkdirp } from '../../storage/io.js';
import {
  settingDir,
  userSkillsDir,
  canvasMemoryDir,
} from '../../storage/paths.js';

import type { MemoryLogger } from './index.js';

export interface WriteResult {
  ok: boolean;
  /** Absolute path the writer targeted (resolved through the sandbox). */
  target: string;
  /** Short, agent-readable reason — populated on both success and reject. */
  reason: string;
}

/** Body cap shared by workspace + canvas memory. */
export const MEMORY_BYTE_CAP = 4 * 1024;
export const MEMORY_LINE_CAP = 80;

/** Minimum rationale length for `writeSkill({ op: 'create' })`. */
export const SKILL_CREATE_RATIONALE_MIN = 20;

// ─── Long-term memory ──────────────────────────────────────────────────────

/**
 * Apply a patch to `<workspace>/setting/.huabu.md`.
 *
 * Two modes:
 *   - `'patch'`   merges new bullet-style lines into the existing body
 *                 with simple dedup (`trim()` equality). Existing
 *                 user-edited prose is preserved verbatim — patches
 *                 only *add* lines.
 *   - `'replace'` overwrites the body wholesale. Reserved for an
 *                 eventual LLM-driven consolidate path; rejected in
 *                 this phase so the sub-agent cannot accidentally
 *                 nuke user-edited content.
 *
 * The `diff` parameter is the *new* content to integrate: in `patch`
 * mode each non-empty trimmed line is treated as an additional bullet
 * (the leading `+`/`-`/`*` is stripped if present, then re-prefixed
 * with `- `). Cap check runs against the merged body.
 */
export function writeWorkspaceMemory(args: {
  mode: 'patch' | 'replace';
  diff: string;
  logger?: MemoryLogger;
}): WriteResult {
  let target = '<unresolved>';
  try {
    target = resolveLongTermPath();
    if (args.mode !== 'patch') {
      return reject(
        target,
        `workspace-memory writer only accepts mode="patch" in this phase`,
      );
    }

    const existing = readOrEmpty(target);
    const merged = mergeBullets(existing, args.diff);
    const capCheck = checkCap(merged);
    if (!capCheck.ok) return reject(target, capCheck.reason);

    mkdirp(settingDir());
    atomicWriteText(target, merged);
    args.logger?.info(
      `[memory] workspace memory updated (${merged.length} bytes, ${merged.split('\n').length} lines)`,
    );
    return { ok: true, target, reason: 'patched' };
  } catch (err) {
    return rejectFromError(err, target);
  }
}

/**
 * Merge a patch into an existing workspace memory body.
 *
 * Each non-empty line in `patch` becomes a bullet appended to the
 * existing body — unless an identical-trimmed-content bullet is
 * already present, in which case it is skipped. The function is
 * intentionally simple: no LLM, no fuzzy match. The agent is
 * responsible for emitting clean atomic bullets.
 */
function mergeBullets(existing: string, patch: string): string {
  const existingLines = existing.split('\n');
  const seen = new Set<string>();
  for (const line of existingLines) {
    const trimmed = stripBulletPrefix(line.trim());
    if (trimmed.length > 0) seen.add(trimmed);
  }
  const additions: string[] = [];
  for (const raw of patch.split('\n')) {
    const stripped = stripBulletPrefix(raw.trim());
    if (stripped.length === 0) continue;
    if (seen.has(stripped)) continue;
    seen.add(stripped);
    additions.push(`- ${stripped}`);
  }
  if (additions.length === 0) {
    // Patch was fully redundant. Return the existing body verbatim,
    // ending with one newline. Re-writing the same content is
    // harmless (mtimeMs bumps; loader cache picks it up next scan).
    return existing.endsWith('\n') || existing.length === 0
      ? existing
      : `${existing}\n`;
  }
  const base = existing.trimEnd();
  if (base.length === 0) return `${additions.join('\n')}\n`;
  return `${base}\n${additions.join('\n')}\n`;
}

function stripBulletPrefix(line: string): string {
  // Tolerate Markdown bullets (-, *, +) and unified-diff prefixes (+/-).
  return line.replace(/^[-+*]\s*/, '');
}

// ─── Working memory ────────────────────────────────────────────────────────

/**
 * Replace `<canvasDir>/.memory/canvas.md` with the supplied body.
 *
 * Wholesale replacement is intentional: canvas memory is the
 * agent's "current state" briefing for the canvas, not a journal.
 * Cap check applies to the body.
 */
export function writeCanvasMemory(args: {
  canvasId: string;
  body: string;
  logger?: MemoryLogger;
}): WriteResult {
  let target = '<unresolved>';
  try {
    target = resolveWorkingMemoryPath(args.canvasId);
    const body = ensureTrailingNewline(args.body);
    const capCheck = checkCap(body);
    if (!capCheck.ok) return reject(target, capCheck.reason);

    mkdirp(canvasMemoryDir(args.canvasId));
    atomicWriteText(target, body);
    args.logger?.info(
      `[memory] canvas memory replaced for canvas ${args.canvasId} (${body.length} bytes)`,
    );
    return { ok: true, target, reason: 'replaced' };
  } catch (err) {
    return rejectFromError(err, target);
  }
}

// ─── Skills ────────────────────────────────────────────────────────────────

export interface SkillWriteArgs {
  op: 'create' | 'update';
  id: string;
  /** Display label for new skills; ignored on update (existing kept). */
  title?: string;
  description?: string;
  appliesTo?: string[];
  /** Markdown body. On create: full body. On update: wholesale replacement of the existing body. */
  body: string;
  /** Required when `op === 'create'`; ignored on update. */
  rationale?: string;
  logger?: MemoryLogger;
}

/**
 * Write a user skill.
 *
 * `op === 'create'`:
 *   - Rejects when the skill id already exists user-side (the agent
 *     must use `op === 'update'` instead — this is what the
 *     "be precious with new skills" rule in the AGENT.md enforces).
 *   - Requires a `rationale` (≥ {@link SKILL_CREATE_RATIONALE_MIN} chars)
 *     so the LLM has to justify why no existing skill can be updated.
 *   - Requires `description` and `appliesTo` (at least one scope).
 *     `title` defaults to the id if omitted.
 *
 * `op === 'update'`:
 *   - Requires the skill to already exist.
 *   - Preserves the existing frontmatter (with user-supplied
 *     overrides) and **wholesale-replaces the body** with `args.body`.
 *     If prior content should be preserved or refined, the caller is
 *     expected to read the existing SKILL.md first and merge in the
 *     submitted body — the writer does not auto-append.
 *
 * On success, calls {@link invalidateUserSkill} so the next
 * `read("skills/<id>/SKILL.md")` returns the new content without
 * waiting on the cache TTL.
 */
export function writeSkill(args: SkillWriteArgs): WriteResult {
  let target = '<unresolved>';
  try {
    target = resolveUserSkillPath(args.id);
    const exists = existsSync(target);

    if (args.op === 'create') {
      if (exists) {
        return reject(
          target,
          `skill "${args.id}" already exists user-side; use op="update" instead`,
        );
      }
      const r = args.rationale?.trim() ?? '';
      if (r.length < SKILL_CREATE_RATIONALE_MIN) {
        return reject(
          target,
          `skill create rejected: provide a rationale (>= ${SKILL_CREATE_RATIONALE_MIN} chars) explaining why an existing skill cannot be updated`,
        );
      }
      if (!args.description || args.description.trim().length === 0) {
        return reject(target, 'skill create requires a non-empty description');
      }
      const scopes = sanitiseAppliesTo(args.appliesTo);
      if (scopes.length === 0) {
        return reject(
          target,
          'skill create requires appliesTo with at least one scope (ask|operate|sketch|external)',
        );
      }

      const md = renderSkillMarkdown({
        id: args.id,
        title: (args.title ?? args.id).trim(),
        description: args.description.trim(),
        appliesTo: scopes,
        body: ensureTrailingNewline(args.body),
      });
      mkdirp(userSkillsDir());
      atomicWriteText(target, md);
      invalidateUserSkill(args.id);
      args.logger?.info(
        `[memory] skill "${args.id}" created (${md.length} bytes)`,
      );
      return { ok: true, target, reason: 'created' };
    }

    // op === 'update'
    if (!exists) {
      return reject(
        target,
        `skill "${args.id}" does not exist user-side; use op="create" instead`,
      );
    }
    const raw = readFileSync(target, 'utf8');
    const { meta } = parseFrontmatter(raw);
    if (!meta || Object.keys(meta).length === 0) {
      return reject(
        target,
        `existing user skill "${args.id}" is missing frontmatter; refusing to update`,
      );
    }
    // Body is wholesale-replaced — the caller is expected to read the
    // existing SKILL.md first if they need to preserve / refine prior
    // content. This matches the canvas-memory contract and gives the
    // agent freedom to restructure / shrink / rewrite the body.
    const updatedBody = ensureTrailingNewline(args.body);
    const scopesArg = sanitiseAppliesTo(args.appliesTo);
    const scopesExisting = sanitiseAppliesTo(
      Array.isArray(meta.appliesTo) ? (meta.appliesTo as string[]) : undefined,
    );
    const fm = renderFrontmatter({
      id: String(meta.id ?? args.id),
      name: String(meta.name ?? args.title ?? args.id),
      description: String(
        args.description?.trim() || meta.description || args.id,
      ),
      appliesTo: scopesArg.length > 0 ? scopesArg : scopesExisting,
      version: typeof meta.version === 'number' ? meta.version : undefined,
    });
    const merged = `${fm}\n\n${updatedBody}`;
    atomicWriteText(target, merged);
    invalidateUserSkill(args.id);
    args.logger?.info(
      `[memory] skill "${args.id}" updated (${merged.length} bytes)`,
    );
    return { ok: true, target, reason: 'updated' };
  } catch (err) {
    return rejectFromError(err, target);
  }
}

/** Minimal YAML rendering for skill frontmatter. */
function renderFrontmatter(meta: {
  id: string;
  name: string;
  description: string;
  appliesTo: string[];
  version?: number;
}): string {
  const lines: string[] = ['---'];
  lines.push(`id: ${meta.id}`);
  lines.push(`name: ${yamlString(meta.name)}`);
  lines.push(`description: ${yamlString(meta.description)}`);
  lines.push(
    `appliesTo: [${meta.appliesTo.map((s) => yamlString(s)).join(', ')}]`,
  );
  if (meta.version !== undefined) lines.push(`version: ${meta.version}`);
  lines.push('---');
  return lines.join('\n');
}

function renderSkillMarkdown(args: {
  id: string;
  title: string;
  description: string;
  appliesTo: string[];
  body: string;
}): string {
  const fm = renderFrontmatter({
    id: args.id,
    name: args.title,
    description: args.description,
    appliesTo: args.appliesTo,
  });
  return `${fm}\n\n${args.body}`;
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const VALID_SCOPE_SET: ReadonlySet<string> = new Set([
  'ask',
  'operate',
  'sketch',
  'external',
]);

function sanitiseAppliesTo(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    const s = String(v).trim();
    if (!VALID_SCOPE_SET.has(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readOrEmpty(file: string): string {
  if (!existsSync(file)) return '';
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

function checkCap(s: string): { ok: true } | { ok: false; reason: string } {
  if (Buffer.byteLength(s, 'utf8') > MEMORY_BYTE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${MEMORY_BYTE_CAP} bytes; distil and retry`,
    };
  }
  const lines = s.split('\n').length;
  if (lines > MEMORY_LINE_CAP) {
    return {
      ok: false,
      reason: `body exceeds ${MEMORY_LINE_CAP} lines; distil and retry`,
    };
  }
  return { ok: true };
}

function reject(target: string, reason: string): WriteResult {
  return { ok: false, target, reason };
}

function rejectFromError(err: unknown, target: string): WriteResult {
  if (err instanceof MemorySandboxError) {
    return reject(target, err.message);
  }
  return reject(target, (err as Error).message);
}
