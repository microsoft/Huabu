/**
 * Shared sandbox + filesystem primitives for canvas-scoped tools.
 *
 * Every tool that touches disk (`grep`, `find`, `ls`, `read`, future
 * `write`/`edit`) routes through these helpers so the security model
 * is defined exactly once:
 *
 *  - `safeResolve` is the only place that maps a user-supplied
 *    relative path to an absolute path. It always resolves under the
 *    **current canvas folder** (`<workspace>/<canvasId>/`). Any escape
 *    attempt throws — the agent cannot read or list anything outside
 *    the active canvas.
 *  - `walk` is the only directory traversal. It skips symlinks so an
 *    attacker cannot point a symlink outside the sandbox.
 *  - `ALWAYS_SKIP` is a single source of truth for "directories the
 *    agent should never see" (`.history`, `.git`, `node_modules`).
 *
 * Centralising these means a vulnerability fix is a one-file change
 * and every tool inherits it automatically.
 *
 * The file also owns the small glob dialect (`globToRegExp`) and the
 * canvas-aware path conventions (`CANVAS_NODE_RE`, `makeNodeLookup`)
 * since both `grep`/`find` and `read` need to recognise node files.
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
 * Choose the effective canvas-relative path. When the caller omits
 * `path`, default to the canvas root (".") so a bare grep/find/ls
 * walks the whole canvas folder.
 */
export function effectivePath(userPath: string | undefined): string {
  if (userPath !== undefined && userPath.length > 0) return userPath;
  return '.';
}

// ─── Sandbox resolution ─────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path against the current canvas folder,
 * refusing any value that escapes the sandbox. Returns an absolute
 * path that lives under `<workspace>/<canvasId>/`.
 *
 * The check is intentionally a strict prefix match on `root + path.sep`
 * so that a path that happens to *start with the canvas folder name*
 * (e.g. a sibling `huabu-evil/` next to `huabu/`) cannot be accepted.
 *
 * `canvasId` itself is also validated to prevent traversal via the
 * canvas id (e.g. `..`, `foo/bar`).
 */
export function safeResolve(canvasId: string, rel: string): string {
  if (
    !canvasId ||
    canvasId.includes('/') ||
    canvasId.includes('\\') ||
    canvasId === '.' ||
    canvasId === '..'
  ) {
    throw new Error(`Invalid canvasId: ${canvasId}`);
  }
  const root = path.join(getWorkspacePath(), canvasId);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(
      `Path "${rel}" escapes the canvas root and is not allowed.`,
    );
  }
  return target;
}

/** Normalise a relative path to forward slashes. */
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

// ─── Canvas-relative path conventions ──────────────────────────────────────

/**
 * Match a canvas-relative path of the form
 *   "nodes/<nodeId>.md"
 * Used to recognise node files within the active canvas.
 */
export const CANVAS_NODE_RE = /^nodes\/(node-[^/]+)\.md$/;

/**
 * Compose a canvas-relative path from the walk root (canvas-relative)
 * and a path relative to that walk root.
 */
export function joinCanvasRel(
  walkRootCanvasRel: string,
  walkRel: string,
): string {
  if (!walkRel) return walkRootCanvasRel;
  if (!walkRootCanvasRel || walkRootCanvasRel === '.') return walkRel;
  return `${walkRootCanvasRel}/${walkRel}`;
}

// ─── Node enrichment ────────────────────────────────────────────────────────

export interface NodeMeta {
  nodeId: string;
  nodeType: string | undefined;
  label: string | undefined;
}

/**
 * Lazy single-canvas node lookup. Reads `canvas.json` at most once,
 * returning a closure that maps a canvas-relative path to its
 * `NodeMeta` if it matches `nodes/<nodeId>.md` AND that node exists.
 * Returns `null` otherwise.
 */
export function makeNodeLookup(
  canvasId: string,
): (canvasRelPath: string) => NodeMeta | null {
  let cache: Map<string, NodeMeta> | null = null;
  const ensure = (): Map<string, NodeMeta> => {
    if (cache) return cache;
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
        built.set(id, { nodeId: id, nodeType, label });
      }
    }
    cache = built;
    return built;
  };
  return (canvasRelPath) => {
    const m = canvasRelPath.match(CANVAS_NODE_RE);
    if (!m || !m[1]) return null;
    return ensure().get(m[1]) ?? null;
  };
}
