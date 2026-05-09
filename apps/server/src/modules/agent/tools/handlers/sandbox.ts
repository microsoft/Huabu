/**
 * Shared sandbox + filesystem primitives for workspace-scoped tools.
 *
 * Every tool that touches disk (`grep`, `find`, `ls`, `read`, future
 * `write`/`edit`) routes through these helpers so the security model
 * is defined exactly once:
 *
 *  - `safeResolve` is the only place that maps a user-supplied
 *    relative path to an absolute path. Any escape attempt throws.
 *  - `walk` is the only directory traversal. It skips symlinks so an
 *    attacker cannot point a symlink outside the workspace.
 *  - `ALWAYS_SKIP` is a single source of truth for "directories the
 *    agent should never see" (`.history`, `.git`, `node_modules`).
 *
 * Centralising these means a vulnerability fix is a one-file change
 * and every tool inherits it automatically.
 *
 * The file also owns the small glob dialect (`globToRegExp`) and the
 * canvas-aware path conventions (`WORKSPACE_NODE_RE`,
 * `toWorkspaceRel`, `makeNodeLookup`) since both `grep`/`find` and
 * `read` need to recognise node files.
 */

import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

import { getCanvasStore } from '../../../storage/index.js';
import { getWorkspacePath } from '../../../workspace.js';

// ─── Always-skipped directory names ─────────────────────────────────────────

/** Directories never traversed. Holds chat history, vcs, build outputs. */
export const ALWAYS_SKIP: ReadonlySet<string> = new Set([
  '.history',
  '.git',
  'node_modules',
]);

// ─── Path defaulting ────────────────────────────────────────────────────────

/**
 * Choose the effective relative path. When the caller omits `path`,
 * default to the current canvas folder (so a bare grep/find/ls stays
 * scoped to the active canvas). When neither is available, default to
 * the workspace root.
 */
export function effectivePath(
  userPath: string | undefined,
  currentCanvasId: string | undefined,
): string {
  if (userPath !== undefined && userPath.length > 0) return userPath;
  if (currentCanvasId) return currentCanvasId;
  return '.';
}

// ─── Sandbox resolution ─────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path against the workspace root, refusing
 * any value that escapes the sandbox. Returns an absolute path that
 * lives under the workspace root.
 *
 * The check is intentionally a strict prefix match on
 * `root + path.sep` so that a path that happens to *start with the
 * workspace name* (e.g. a sibling `huabu-evil/` next to `huabu/`)
 * cannot be accepted.
 */
export function safeResolve(rel: string): string {
  const root = getWorkspacePath();
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Path "${rel}" escapes the workspace root and is not allowed.`,
    );
  }
  return target;
}

/** Normalise a workspace-relative path to forward slashes. */
export function normalizeRel(rel: string): string {
  return rel.split(path.sep).join('/');
}

// ─── Glob → RegExp ──────────────────────────────────────────────────────────

/**
 * Convert a small glob dialect to a RegExp. Supports:
 *  - `*`     — any chars except `/`
 *  - `**`    — any chars including `/` (consumes adjacent `/`)
 *  - `?`     — single char except `/`
 *  - `{a,b}` — alternation
 *
 * Patterns are anchored to the full relative path. We deliberately do
 * not pull in `picomatch` / `minimatch` — adding 50 KB of deps for
 * three glob features the agent will actually use is not worth it.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === '*') {
      if (glob.charAt(i + 1) === '*') {
        out += '.*';
        i += 2;
        if (glob.charAt(i) === '/') i++;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += '[^/]';
      i++;
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) {
        out += '\\{';
        i++;
      } else {
        const opts = glob.slice(i + 1, close).split(',');
        out += `(?:${opts
          .map((o) => o.replace(/[\\^$+.()|[\]{}*?]/g, '\\$&'))
          .join('|')})`;
        i = close + 1;
      }
    } else if ('\\^$+.()|[]'.includes(c)) {
      out += '\\' + c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}

// ─── Recursive walk ─────────────────────────────────────────────────────────

export interface WalkEntry {
  /** Path relative to the walk root, using forward slashes. */
  relPath: string;
  /** Absolute path on disk. */
  absPath: string;
  isDirectory: boolean;
}

/**
 * Iterative walker. Skips `ALWAYS_SKIP` directory names and never
 * follows symlinks (entries with `isSymbolicLink()` are skipped to
 * keep the sandbox tight).
 */
export function* walk(rootAbs: string): Generator<WalkEntry> {
  const stack: Array<{ abs: string; rel: string }> = [
    { abs: rootAbs, rel: '' },
  ];
  while (stack.length) {
    const next = stack.pop();
    if (!next) break;
    const { abs, rel } = next;
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ALWAYS_SKIP.has(ent.name)) continue;
      if (ent.isSymbolicLink()) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        yield { relPath: childRel, absPath: childAbs, isDirectory: true };
        stack.push({ abs: childAbs, rel: childRel });
      } else if (ent.isFile()) {
        yield { relPath: childRel, absPath: childAbs, isDirectory: false };
      }
    }
  }
}

// ─── Workspace-relative path conventions ────────────────────────────────────

/**
 * Match `<workspace-relative-path>` of the form
 *   "<canvasId>/nodes/<nodeId>.md"
 * The `<canvasId>` segment is whatever came in from disk; the executor
 * only ever opens canvases that live directly under the workspace root.
 */
export const WORKSPACE_NODE_RE = /^([^/]+)\/nodes\/(node-[^/]+)\.md$/;

/**
 * Reconstruct a relative path *as the LLM should see it* given the
 * walk root and a path relative to that walk root. The LLM's mental
 * model is "paths are relative to the workspace root", so we always
 * report the workspace-relative form, regardless of which subtree the
 * walk started in.
 */
export function toWorkspaceRel(
  walkRootRelToWorkspace: string,
  walkRel: string,
): string {
  if (!walkRel) return walkRootRelToWorkspace;
  if (!walkRootRelToWorkspace || walkRootRelToWorkspace === '.') return walkRel;
  return `${walkRootRelToWorkspace}/${walkRel}`;
}

// ─── Node enrichment ────────────────────────────────────────────────────────

export interface NodeMeta {
  canvasId: string;
  nodeId: string;
  nodeType: string | undefined;
  label: string | undefined;
}

/**
 * Per-call cache of `<canvasId> → Map<nodeId, NodeMeta>`. Lazily
 * populated the first time we see a node file from a given canvas, so
 * a single grep/find never reads `canvas.json` more than once per
 * canvas.
 *
 * Returned closure: given a workspace-relative path, return its
 * NodeMeta if the path matches `<canvasId>/nodes/<nodeId>.md` AND the
 * node exists in that canvas's `canvas.json`. Otherwise `null`.
 */
export function makeNodeLookup(): (
  workspaceRelPath: string,
) => NodeMeta | null {
  const caches = new Map<string, Map<string, NodeMeta>>();
  const ensure = (canvasId: string): Map<string, NodeMeta> => {
    const cached = caches.get(canvasId);
    if (cached) return cached;
    const built = new Map<string, NodeMeta>();
    let file;
    try {
      file = getCanvasStore(canvasId).read();
    } catch {
      file = null;
    }
    if (file) {
      const nodes = (file.state.nodes ?? []) as Array<Record<string, unknown>>;
      for (const n of nodes) {
        const id = n.id;
        if (typeof id !== 'string') continue;
        const data = n.data as Record<string, unknown> | undefined;
        const nodeType = (n.type ?? data?.type) as string | undefined;
        const label = typeof data?.label === 'string' ? data.label : undefined;
        built.set(id, { canvasId, nodeId: id, nodeType, label });
      }
    }
    caches.set(canvasId, built);
    return built;
  };
  return (workspaceRelPath) => {
    const m = workspaceRelPath.match(WORKSPACE_NODE_RE);
    if (!m || !m[1] || !m[2]) return null;
    return ensure(m[1]).get(m[2]) ?? null;
  };
}
