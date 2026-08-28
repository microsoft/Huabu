// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Filesystem tools — grep, find, ls — scoped to the current canvas.
 *
 *
 * Implementation is pure Node — no `child_process`, no `ripgrep`, no
 * `fd`, no extra deps — because:
 *  - the server must run on minimal Docker / Edge runtimes;
 *  - workspace data volumes are small (tens to thousands of files,
 *    KB each);
 *  - sandboxing a child process to one canvas is harder than just
 *    keeping every path resolution in-process.
 *
 * The sandbox itself (path resolution, walk, glob, node lookup) lives
 * in `./fs-sandbox.ts` so that `read` and any future fs tool inherit
 * the exact same security model.
 *
 * Enrichment: when a result file is `nodes/<filename>.md`, the response
 * includes `nodeId`, `label`, and `nodeType` from the canvas's
 * structural metadata so the LLM can chain straight into `read` (for the
 * rest of the file), `inspect_nodes` (for layout / style / spatial
 * relations), or `canvas_commands` (for writes) without a second
 * lookup. This is the one place we deviate from pi: pi returns raw
 * `path:line: text`, we return JSON with optional node metadata.
 *
 * Errors throw — pi-agent-core's executor catches and surfaces them
 * as `isError: true` tool results (see its `AgentTool.execute`
 * contract).
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from 'node:fs';

import {
  effectivePath,
  globToRegExp,
  joinCanvasRel,
  makeNodeLookup,
  normalizeRel,
  safeResolve,
  toPhysicalRel,
  walk,
} from './fs-sandbox.js';

import type {
  findParamsSchema,
  grepParamsSchema,
  lsParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────
//
// `canvasId` is injected by the executor from the request context;
// it is *not* part of the LLM-visible schema. It scopes every fs
// operation to the current canvas folder.

export type GrepArgs = Static<typeof grepParamsSchema> & { canvasId: string };
export type FindArgs = Static<typeof findParamsSchema> & { canvasId: string };
export type LsArgs = Static<typeof lsParamsSchema> & { canvasId: string };

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Output caps. Mirror pi's defaults so the LLM's intuition transfers. */
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

/** Per-line truncation so a single long line cannot blow the budget. */
const MAX_LINE_LENGTH = 500;

// ─── ReDoS / DoS guardrails ─────────────────────────────────────────────────
//
// Node's RegExp has no built-in execution timeout, so a malicious or
// just careless pattern like `(a+)+$` can pin the event loop. We rely
// on three layered caps:
//   1. Hard ceiling on the pattern itself — kills the most obvious
//      pathological inputs at the door.
//   2. Hard ceiling on the per-line slice fed to `regex.test()` — even
//      a catastrophic-backtracking pattern is bounded by input length.
//   3. Per-file size cap so a 100 MB blob cannot block the event loop
//      on `readFileSync` alone.
//   4. Soft wall-clock deadline across the whole grep call as a final
//      backstop; on hit, we bail with `truncated:true`.

const MAX_PATTERN_LENGTH = 1000;
const MAX_GLOB_LENGTH = 1000;
const MAX_LINE_BYTES_TO_SCAN = 8 * 1024;
const MAX_GREP_FILE_BYTES = 5 * 1024 * 1024;
const GREP_DEADLINE_MS = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncateLine(s: string): string {
  return s.length > MAX_LINE_LENGTH ? s.slice(0, MAX_LINE_LENGTH) + '…' : s;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[\\^$+.()|[\]{}*?]/g, '\\$&');
}

// ─── grep ───────────────────────────────────────────────────────────────────

export async function handleGrep(args: GrepArgs): Promise<string> {
  const {
    pattern,
    path: searchPath,
    glob,
    ignoreCase,
    literal,
    context: ctxLines,
    limit,
  } = args;

  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `Pattern is ${pattern.length} chars, exceeds the ${MAX_PATTERN_LENGTH} char limit. Narrow the pattern.`,
    );
  }
  if (glob && glob.length > MAX_GLOB_LENGTH) {
    throw new Error(
      `Glob is ${glob.length} chars, exceeds the ${MAX_GLOB_LENGTH} char limit.`,
    );
  }

  const walkRootRel = normalizeRel(effectivePath(searchPath));
  // safeResolve throws on sandbox escape; let pi-agent-core wrap that.
  const root = safeResolve(args.canvasId, walkRootRel);
  if (!existsSync(root)) {
    throw new Error(`Path not found: ${walkRootRel}`);
  }

  let regex: RegExp;
  try {
    regex = new RegExp(
      literal ? escapeRegex(pattern) : pattern,
      ignoreCase ? 'i' : '',
    );
  } catch (e) {
    throw new Error(`Invalid pattern: ${(e as Error).message}`);
  }

  // Glob is matched against each file's path **relative to the search
  // root** (`e.relPath`), not its canvas-relative path. This mirrors
  // `find` (and ripgrep / fd) and matches the directory the user
  // already targeted via `path:` — otherwise a natural call like
  // `grep({ path: "nodes", glob: "*.md" })` would silently 0-match
  // because every candidate is `nodes/<file>.md` (containing a `/`)
  // while `*.md` compiles to `^[^/]*\.md$`.
  //
  // Also: a glob without `/` is treated as "match at any depth" so
  // `*.md` finds `nodes/sub/foo.md`. Same convention as `find`.
  //
  // A clean virtual prefix (`upload/`, `artifacts/`) is normalized to its
  // hidden on-disk form first so it matches the physical relPaths walk emits.
  const physGlob = glob ? toPhysicalRel(glob) : glob;
  const effectiveGlob =
    physGlob && !physGlob.includes('/') && !physGlob.startsWith('**')
      ? `**/${physGlob}`
      : physGlob;
  const globRe = effectiveGlob ? globToRegExp(effectiveGlob) : null;
  const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
  const ctxN = Math.max(0, ctxLines ?? 0);
  const lookup = await makeNodeLookup(args.canvasId);
  const deadline = Date.now() + GREP_DEADLINE_MS;

  // Enumerate candidate files, recording each as a canvas-relative
  // path so enrichment can recognise node files.
  const candidates: Array<{ canvasRel: string; absPath: string }> = [];
  const stat = statSync(root);
  if (stat.isFile()) {
    candidates.push({ canvasRel: walkRootRel, absPath: root });
  } else {
    for (const e of walk(root)) {
      if (e.isDirectory) continue;
      if (globRe && !globRe.test(e.relPath)) continue;
      const canvasRel = joinCanvasRel(walkRootRel, e.relPath);
      candidates.push({ canvasRel, absPath: e.absPath });
    }
  }

  const matches: Array<Record<string, unknown>> = [];
  let truncated = false;

  outer: for (const ent of candidates) {
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }
    // Skip oversized files entirely — they cannot give useful matches
    // through this tool and would block the event loop on read+split.
    let fileSize: number;
    try {
      fileSize = statSync(ent.absPath).size;
    } catch {
      continue;
    }
    if (fileSize > MAX_GREP_FILE_BYTES) continue;
    let text: string;
    try {
      text = readFileSync(ent.absPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Wall-clock backstop: if a previous line's regex.test spent too
      // long, bail out before scanning more.
      if ((i & 0xff) === 0 && Date.now() > deadline) {
        truncated = true;
        break outer;
      }
      const rawLine = lines[i] ?? '';
      // Cap the slice handed to regex.test so even pathological
      // backtracking on a malicious one-liner cannot blow up.
      const line =
        rawLine.length > MAX_LINE_BYTES_TO_SCAN
          ? rawLine.slice(0, MAX_LINE_BYTES_TO_SCAN)
          : rawLine;
      if (!regex.test(line)) continue;
      const match: Record<string, unknown> = {
        path: ent.canvasRel,
        line: i + 1,
        text: truncateLine(rawLine),
      };
      if (ctxN > 0) {
        match.before = lines.slice(Math.max(0, i - ctxN), i).map(truncateLine);
        match.after = lines.slice(i + 1, i + 1 + ctxN).map(truncateLine);
      }
      const meta = lookup(ent.canvasRel);
      if (meta) {
        match.nodeId = meta.nodeId;
        if (meta.nodeType !== undefined) match.nodeType = meta.nodeType;
        if (meta.label !== undefined) match.label = meta.label;
      }
      matches.push(match);
      if (matches.length >= effectiveLimit) {
        truncated = true;
        break outer;
      }
    }
  }

  return JSON.stringify({
    matches,
    count: matches.length,
    truncated,
  });
}

// ─── find ───────────────────────────────────────────────────────────────────

export async function handleFind(args: FindArgs): Promise<string> {
  const { pattern, path: searchPath, limit } = args;

  if (pattern.length > MAX_GLOB_LENGTH) {
    throw new Error(
      `Pattern is ${pattern.length} chars, exceeds the ${MAX_GLOB_LENGTH} char limit.`,
    );
  }

  const walkRootRel = normalizeRel(effectivePath(searchPath));
  // safeResolve throws on sandbox escape; let pi-agent-core wrap that.
  const root = safeResolve(args.canvasId, walkRootRel);
  if (!existsSync(root)) {
    throw new Error(`Path not found: ${walkRootRel}`);
  }

  // Mirror pi/fd: a pattern without "/" matches any depth. With "/" it
  // anchors to the relative path under the search root. A clean virtual
  // prefix (`upload/`, `artifacts/`) is normalized to its hidden on-disk
  // form first so it matches the physical relPaths walk emits.
  const physPattern = toPhysicalRel(pattern);
  const effectivePattern = physPattern.includes('/')
    ? physPattern
    : `**/${physPattern}`;
  let regex: RegExp;
  try {
    regex = globToRegExp(effectivePattern);
  } catch (e) {
    throw new Error(`Invalid glob: ${(e as Error).message}`);
  }

  const effectiveLimit = Math.max(1, limit ?? DEFAULT_FIND_LIMIT);
  const lookup = await makeNodeLookup(args.canvasId);

  const results: Array<Record<string, unknown>> = [];
  let truncated = false;
  for (const e of walk(root)) {
    if (e.isDirectory) continue;
    // Match the glob against the path *as the walk surfaces it* so that
    // user patterns like "nodes/*.md" still behave as expected.
    if (!regex.test(e.relPath)) continue;
    const canvasRel = joinCanvasRel(walkRootRel, e.relPath);
    const entry: Record<string, unknown> = { path: canvasRel };
    const meta = lookup(canvasRel);
    if (meta) {
      entry.nodeId = meta.nodeId;
      if (meta.nodeType !== undefined) entry.nodeType = meta.nodeType;
      if (meta.label !== undefined) entry.label = meta.label;
    }
    results.push(entry);
    if (results.length >= effectiveLimit) {
      truncated = true;
      break;
    }
  }
  results.sort((a, b) => (a.path as string).localeCompare(b.path as string));

  return JSON.stringify({
    paths: results,
    count: results.length,
    truncated,
  });
}

// ─── ls ─────────────────────────────────────────────────────────────────────

export async function handleLs(args: LsArgs): Promise<string> {
  const { path: dirPath, limit } = args;

  const walkRootRel = normalizeRel(effectivePath(dirPath));
  // safeResolve throws on sandbox escape; let pi-agent-core wrap that.
  const root = safeResolve(args.canvasId, walkRootRel);
  if (!existsSync(root)) {
    throw new Error(`Path not found: ${walkRootRel}`);
  }

  let stat;
  try {
    stat = statSync(root);
  } catch (e) {
    throw new Error(`Cannot stat: ${(e as Error).message}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${walkRootRel}`);
  }

  const effectiveLimit = Math.max(1, limit ?? DEFAULT_LS_LIMIT);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    throw new Error(`Cannot read directory: ${(e as Error).message}`);
  }

  // Match pi: alphabetical case-insensitive, dotfiles included, '/'
  // suffix on directories.
  entries.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  // Eligible entries (after symlink filter) — used to populate `total`
  // so the agent can tell whether `truncated:true` means "raise limit"
  // is worthwhile (and by how much).
  const eligible = entries.filter((e) => !e.isSymbolicLink());
  const out: string[] = [];
  for (const ent of eligible) {
    if (out.length >= effectiveLimit) break;
    out.push(ent.isDirectory() ? `${ent.name}/` : ent.name);
  }
  const total = eligible.length;
  const truncated = total > out.length;

  return JSON.stringify({
    path: walkRootRel,
    entries: out,
    count: out.length,
    total,
    truncated,
  });
}
