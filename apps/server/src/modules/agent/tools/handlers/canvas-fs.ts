/**
 * Filesystem tools — grep, find, ls — scoped to the active workspace.
 *
 *
 * Implementation is pure Node — no `child_process`, no `ripgrep`, no
 * `fd`, no extra deps — because:
 *  - the server must run on minimal Docker / Edge runtimes;
 *  - workspace data volumes are small (tens to thousands of files,
 *    KB each);
 *  - sandboxing a child process to one workspace is harder than just
 *    keeping every path resolution in-process.
 *
 * The sandbox itself (path resolution, walk, glob, node lookup) lives
 * in `./sandbox.ts` so that `read` and any future fs tool inherit the
 * exact same security model.
 *
 * Enrichment: when a result file is `<canvasId>/nodes/<nodeId>.md`,
 * the response includes `canvasId`, `nodeId`, `label`, and `nodeType`
 * from that canvas's `canvas.json` so the LLM can chain straight into
 * `get_node_detail` / `canvas_commands` without a second lookup. This
 * is the one place we deviate from pi: pi returns raw
 * `path:line: text`, we return JSON with optional canvas metadata.
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
  makeNodeLookup,
  normalizeRel,
  safeResolve,
  toWorkspaceRel,
  walk,
} from './sandbox.js';

import type {
  findParamsSchema,
  grepParamsSchema,
  lsParamsSchema,
} from '../definitions.js';
import type { Static } from '@earendil-works/pi-ai';

// ─── Argument types ─────────────────────────────────────────────────────────
//
// `currentCanvasId` is injected by the executor from the request
// context; it is *not* part of the LLM-visible schema. It only
// determines the implicit default search path.

export type GrepArgs = Static<typeof grepParamsSchema> & {
  currentCanvasId?: string;
};
export type FindArgs = Static<typeof findParamsSchema> & {
  currentCanvasId?: string;
};
export type LsArgs = Static<typeof lsParamsSchema> & {
  currentCanvasId?: string;
};

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Output caps. Mirror pi's defaults so the LLM's intuition transfers. */
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_LS_LIMIT = 500;

/** Per-line truncation so a single long line cannot blow the budget. */
const MAX_LINE_LENGTH = 500;

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

  const walkRootRel = normalizeRel(
    effectivePath(searchPath, args.currentCanvasId),
  );
  let root: string;
  try {
    root = safeResolve(walkRootRel);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
  if (!existsSync(root)) {
    return JSON.stringify({ error: `Path not found: ${walkRootRel}` });
  }

  let regex: RegExp;
  try {
    regex = new RegExp(
      literal ? escapeRegex(pattern) : pattern,
      ignoreCase ? 'i' : '',
    );
  } catch (e) {
    return JSON.stringify({
      error: `Invalid pattern: ${(e as Error).message}`,
    });
  }

  const globRe = glob ? globToRegExp(glob) : null;
  const effectiveLimit = Math.max(1, limit ?? DEFAULT_GREP_LIMIT);
  const ctxN = Math.max(0, ctxLines ?? 0);
  const lookup = makeNodeLookup();

  // Enumerate candidate files, recording each as a workspace-relative
  // path so enrichment can look up its canvasId.
  const candidates: Array<{ workspaceRel: string; absPath: string }> = [];
  const stat = statSync(root);
  if (stat.isFile()) {
    candidates.push({ workspaceRel: walkRootRel, absPath: root });
  } else {
    for (const e of walk(root)) {
      if (e.isDirectory) continue;
      const workspaceRel = toWorkspaceRel(walkRootRel, e.relPath);
      if (globRe && !globRe.test(workspaceRel)) continue;
      candidates.push({ workspaceRel, absPath: e.absPath });
    }
  }

  const matches: Array<Record<string, unknown>> = [];
  let limitReached = false;

  outer: for (const ent of candidates) {
    let text: string;
    try {
      text = readFileSync(ent.absPath, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (!regex.test(line)) continue;
      const match: Record<string, unknown> = {
        path: ent.workspaceRel,
        line: i + 1,
        text: truncateLine(line),
      };
      if (ctxN > 0) {
        match.before = lines.slice(Math.max(0, i - ctxN), i).map(truncateLine);
        match.after = lines.slice(i + 1, i + 1 + ctxN).map(truncateLine);
      }
      const meta = lookup(ent.workspaceRel);
      if (meta) {
        match.canvasId = meta.canvasId;
        match.nodeId = meta.nodeId;
        if (meta.nodeType !== undefined) match.nodeType = meta.nodeType;
        if (meta.label !== undefined) match.label = meta.label;
      }
      matches.push(match);
      if (matches.length >= effectiveLimit) {
        limitReached = true;
        break outer;
      }
    }
  }

  return JSON.stringify({
    matches,
    count: matches.length,
    limitReached,
  });
}

// ─── find ───────────────────────────────────────────────────────────────────

export async function handleFind(args: FindArgs): Promise<string> {
  const { pattern, path: searchPath, limit } = args;

  const walkRootRel = normalizeRel(
    effectivePath(searchPath, args.currentCanvasId),
  );
  let root: string;
  try {
    root = safeResolve(walkRootRel);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
  if (!existsSync(root)) {
    return JSON.stringify({ error: `Path not found: ${walkRootRel}` });
  }

  // Mirror pi/fd: a pattern without "/" matches any depth. With "/" it
  // anchors to the relative path under the search root.
  const effectivePattern = pattern.includes('/') ? pattern : `**/${pattern}`;
  let regex: RegExp;
  try {
    regex = globToRegExp(effectivePattern);
  } catch (e) {
    return JSON.stringify({ error: `Invalid glob: ${(e as Error).message}` });
  }

  const effectiveLimit = Math.max(1, limit ?? DEFAULT_FIND_LIMIT);
  const lookup = makeNodeLookup();

  const results: Array<Record<string, unknown>> = [];
  let limitReached = false;
  for (const e of walk(root)) {
    if (e.isDirectory) continue;
    // Match the glob against the path *as the walk surfaces it* so that
    // user patterns like "nodes/*.md" still behave as expected even
    // when path is set to "<canvasId>" — they expect to match relative
    // to the search path, not the workspace.
    if (!regex.test(e.relPath)) continue;
    const workspaceRel = toWorkspaceRel(walkRootRel, e.relPath);
    const entry: Record<string, unknown> = { path: workspaceRel };
    const meta = lookup(workspaceRel);
    if (meta) {
      entry.canvasId = meta.canvasId;
      entry.nodeId = meta.nodeId;
      if (meta.nodeType !== undefined) entry.nodeType = meta.nodeType;
      if (meta.label !== undefined) entry.label = meta.label;
    }
    results.push(entry);
    if (results.length >= effectiveLimit) {
      limitReached = true;
      break;
    }
  }
  results.sort((a, b) => (a.path as string).localeCompare(b.path as string));

  return JSON.stringify({
    paths: results,
    count: results.length,
    limitReached,
  });
}

// ─── ls ─────────────────────────────────────────────────────────────────────

export async function handleLs(args: LsArgs): Promise<string> {
  const { path: dirPath, limit } = args;

  const walkRootRel = normalizeRel(
    effectivePath(dirPath, args.currentCanvasId),
  );
  let root: string;
  try {
    root = safeResolve(walkRootRel);
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
  if (!existsSync(root)) {
    return JSON.stringify({ error: `Path not found: ${walkRootRel}` });
  }

  let stat;
  try {
    stat = statSync(root);
  } catch (e) {
    return JSON.stringify({ error: `Cannot stat: ${(e as Error).message}` });
  }
  if (!stat.isDirectory()) {
    return JSON.stringify({ error: `Not a directory: ${walkRootRel}` });
  }

  const effectiveLimit = Math.max(1, limit ?? DEFAULT_LS_LIMIT);
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return JSON.stringify({
      error: `Cannot read directory: ${(e as Error).message}`,
    });
  }

  // Match pi: alphabetical case-insensitive, dotfiles included, '/'
  // suffix on directories.
  entries.sort((a, b) =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
  const out: string[] = [];
  let limitReached = false;
  for (const ent of entries) {
    if (out.length >= effectiveLimit) {
      limitReached = true;
      break;
    }
    if (ent.isSymbolicLink()) continue;
    out.push(ent.isDirectory() ? `${ent.name}/` : ent.name);
  }

  return JSON.stringify({
    path: walkRootRel,
    entries: out,
    count: out.length,
    limitReached,
  });
}
