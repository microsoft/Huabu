import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { getLogger } from '../../utils/logger.js';
import {
  listAllCanvasDirEntries,
  refreshCanvasDirIndex,
} from '../storage/canvas-dirs.js';
import { parseFrontmatter } from '../storage/frontmatter.js';
import { getCanvasStore } from '../storage/index.js';
import { WORLD_CANVAS_DIR_NAME } from '../storage/paths.js';
import { getWorkspacePath, isWorkspaceConfigured } from '../workspace.js';

import type { ExternalNoteEvent, ExternalNoteItem } from '@sediment/shared';

type Listener = (event: ExternalNoteEvent) => void;

const pendingByCanvas = new Map<string, Map<string, ExternalNoteItem>>();
const listenersByCanvas = new Map<string, Set<Listener>>();
let watcher: FSWatcher | null = null;

function resolvePath(
  absPath: string,
): { canvasId: string; relativePath: string } | null {
  if (!isWorkspaceConfigured()) return null;
  const ws = getWorkspacePath();
  const prefix = ws.endsWith(path.sep) ? ws : ws + path.sep;
  if (!absPath.startsWith(prefix)) return null;
  const parts = absPath.slice(prefix.length).split(path.sep);
  if (parts.length !== 3 || parts[1] !== 'nodes') return null;
  if (!parts[2].endsWith('.md')) return null;
  refreshCanvasDirIndex();
  for (const entry of listAllCanvasDirEntries()) {
    if (entry.filename === parts[0]) {
      return { canvasId: entry.id, relativePath: `nodes/${parts[2]}` };
    }
  }
  return null;
}

function canvasNoteIds(canvasId: string): Set<string> {
  const canvas = getCanvasStore(canvasId).read();
  const ids = new Set<string>();
  if (!canvas) return ids;
  for (const n of canvas.state.nodes) {
    const id = (n as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

async function buildItem(
  absPath: string,
  canvasId: string,
  relativePath: string,
): Promise<ExternalNoteItem | null> {
  try {
    const [raw, st] = await Promise.all([
      readFile(absPath, 'utf8'),
      stat(absPath),
    ]);
    const { meta } = parseFrontmatter(raw);
    const rawId = meta['id'];
    const noteId = typeof rawId === 'string' && rawId ? rawId : undefined;
    if (noteId && canvasNoteIds(canvasId).has(noteId)) return null;
    return {
      relativePath,
      fileName: path.basename(absPath),
      noteId,
      mtime: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

function emit(canvasId: string, event: ExternalNoteEvent): void {
  const set = listenersByCanvas.get(canvasId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

async function handleAdd(absPath: string): Promise<void> {
  const resolved = resolvePath(absPath);
  if (!resolved) return;
  const { canvasId, relativePath } = resolved;
  const item = await buildItem(absPath, canvasId, relativePath);
  if (!item) return;
  let map = pendingByCanvas.get(canvasId);
  if (!map) {
    map = new Map();
    pendingByCanvas.set(canvasId, map);
  }
  if (map.has(relativePath)) return;
  map.set(relativePath, item);
  emit(canvasId, { type: 'added', data: item });
}

function handleUnlink(absPath: string): void {
  const resolved = resolvePath(absPath);
  if (!resolved) return;
  const { canvasId, relativePath } = resolved;
  const map = pendingByCanvas.get(canvasId);
  if (!map?.delete(relativePath)) return;
  emit(canvasId, { type: 'removed', data: { relativePath } });
}

/**
 * Build and wire a chokidar watcher against the active workspace, storing
 * it in the module-level `watcher`. Pending state is left untouched so the
 * caller decides whether a fresh scan should clear it (workspace switch) or
 * preserve it (resume after a self-write suspension). No-op when no
 * workspace is configured.
 */
function armWatcher(): void {
  if (!isWorkspaceConfigured()) return;
  const ws = getWorkspacePath();
  // chokidar v5 removed glob support, so watch the workspace root and
  // filter via `ignored` + `resolvePath()` in the event handlers. Depth
  // is capped at 2 so we never descend into `nodes/` siblings or
  // hidden subdirs by accident.
  watcher = chokidar.watch(ws, {
    ignoreInitial: false,
    depth: 2,
    ignored: (candidate: string) => {
      const basename = path.basename(candidate);
      if (!basename.startsWith('.')) return false;
      return (
        path.resolve(candidate) !==
        path.join(path.resolve(ws), WORLD_CANVAS_DIR_NAME)
      );
    },
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 50 },
  });
  watcher
    .on('add', (abs: string) => void handleAdd(abs))
    .on('unlink', (abs: string) => handleUnlink(abs))
    // Swallow watcher errors. When a canvas directory is deleted while
    // chokidar is mid-scan (common on virtual/network filesystems such as
    // Google Drive), readdirp can emit a transient EINVAL/ENOENT `lstat`
    // error. Without this handler the FSWatcher re-emits it as an unhandled
    // 'error' event, which crashes the whole server process. Log and ignore.
    .on('error', (err: unknown) => {
      getLogger('external-note-watcher').warn(
        { err },
        'external note watcher error (ignored)',
      );
    });
}

// Serialize watcher lifecycle transitions (reset / shutdown). `commitWorkspacePath`
// fires `void resetExternalNoteWatcher()` without awaiting, so two rapid workspace
// activations could otherwise run their close→arm cycles concurrently: the second
// `armWatcher()` overwrites the module-level `watcher` reference before the first
// cycle closes its handle, leaking a live FSWatcher that can never be closed.
// Chaining every transition through one promise guarantees strict ordering.
let lifecycleChain: Promise<void> = Promise.resolve();

function enqueueLifecycle(task: () => Promise<void>): Promise<void> {
  // Run `task` after the previous transition settles, regardless of whether it
  // resolved or rejected, so one failed close can never wedge the chain.
  const run = lifecycleChain.then(task, task);
  lifecycleChain = run.catch(() => undefined);
  return run;
}

/**
 * Stop the current watcher (if any), drop pending state, and re-arm it
 * against the currently active workspace. Safe to call multiple times and
 * from concurrent callers — transitions are serialized so the module-level
 * `watcher` reference is never overwritten before its handle is closed.
 * Listeners are preserved so reconnected clients keep their streams.
 */
export async function resetExternalNoteWatcher(): Promise<void> {
  return enqueueLifecycle(async () => {
    if (watcher) {
      await watcher.close().catch(() => undefined);
      watcher = null;
    }
    pendingByCanvas.clear();
    armWatcher();
  });
}

/**
 * Close the current watcher (if any) and drop pending state *without*
 * re-arming. Call this from the server's shutdown path so the live
 * `fs.watch` handle is released cleanly instead of being force-killed —
 * on virtual/network filesystems (Google Drive) a force-terminated
 * process can leave in-flight watch requests wedged. Serialized against
 * `resetExternalNoteWatcher` through the shared lifecycle chain.
 */
export async function closeExternalNoteWatcher(): Promise<void> {
  return enqueueLifecycle(async () => {
    if (watcher) {
      await watcher.close().catch(() => undefined);
      watcher = null;
    }
    pendingByCanvas.clear();
  });
}

// ── Self-write suspension ────────────────────────────────────────────────
//
// On Windows a live `fs.watch` handle anywhere inside a canvas subtree
// (the canvas dir itself OR its `nodes/` child) makes `renameSync` /
// `rmSync` of that directory fail with EPERM — the handle is persistent,
// so retries never win and `unwatch(subpath)` does not release it. The
// only fix is to fully `close()` the single workspace watcher for the
// duration of a server-owned directory rename/delete, then re-arm it.
//
// The server is the sole legitimate writer of these directories, so
// suspending our own observer around our own write is safe. A depth
// counter lets concurrent/nested suspensions (e.g. a rename racing a
// delete) share one close/re-arm cycle instead of thrashing.
let suspendDepth = 0;
let armAfterResume = false;

/**
 * Run `fn` with the external-note watcher suspended, then re-arm it.
 *
 * Use this to bracket any server-initiated rename or delete of a canvas
 * directory so the live watch handle cannot block the filesystem
 * operation on Windows. Re-arming preserves `pendingByCanvas`: external
 * notes are keyed by `canvasId` + `relativePath` (`nodes/<file>.md`),
 * neither of which a directory rename changes, and the `handleAdd`
 * dedupe guard suppresses duplicate `added` emits during the re-scan —
 * so the client's external-note list does not flicker.
 *
 * A no-op passthrough when the watcher is not currently running (e.g.
 * no workspace configured, or a test harness), so it never spins up a
 * watcher that was intentionally absent.
 */
export async function runWithExternalNoteWatcherSuspended<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  if (suspendDepth === 0) {
    // Only re-arm on exit if a watcher was actually running on entry.
    armAfterResume = watcher !== null;
    if (watcher) {
      await watcher.close().catch(() => undefined);
      watcher = null;
    }
  }
  suspendDepth++;
  try {
    return await fn();
  } finally {
    suspendDepth--;
    if (suspendDepth === 0 && armAfterResume) {
      armAfterResume = false;
      // Prune pending entries for canvases that no longer exist. While the
      // watcher was suspended we observed no `unlink` events, so a canvas
      // deleted during the bracket (its whole subtree `rmSync`'d) would
      // otherwise leave its `pendingByCanvas` map permanently stale — a
      // small leak, and `snapshotExternalNotes` never revisits a deleted
      // canvasId to clear it lazily. Keyed by `canvasId`, so a rename
      // (which changes only the directory name, not the id) is unaffected.
      refreshCanvasDirIndex();
      const liveCanvasIds = new Set(
        listAllCanvasDirEntries().map((entry) => entry.id),
      );
      for (const id of pendingByCanvas.keys()) {
        if (!liveCanvasIds.has(id)) pendingByCanvas.delete(id);
      }
      armWatcher();
    }
  }
}

export function snapshotExternalNotes(canvasId: string): ExternalNoteItem[] {
  const map = pendingByCanvas.get(canvasId);
  if (!map) return [];
  const known = canvasNoteIds(canvasId);
  const out: ExternalNoteItem[] = [];
  for (const [rel, item] of map) {
    if (item.noteId && known.has(item.noteId)) {
      map.delete(rel);
      continue;
    }
    out.push(item);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function subscribeExternalNotes(
  canvasId: string,
  listener: Listener,
): () => void {
  let set = listenersByCanvas.get(canvasId);
  if (!set) {
    set = new Set();
    listenersByCanvas.set(canvasId, set);
  }
  set.add(listener);
  return () => {
    const s = listenersByCanvas.get(canvasId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listenersByCanvas.delete(canvasId);
  };
}

/** Remove and return a pending item — used by the import endpoint. */
export function takeExternalNote(
  canvasId: string,
  relativePath: string,
): ExternalNoteItem | null {
  const map = pendingByCanvas.get(canvasId);
  const item = map?.get(relativePath) ?? null;
  if (item) map?.delete(relativePath);
  return item;
}
