import { watch as watchFs, type FSWatcher as NativeFSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { getLogger } from '../../utils/logger.js';
import {
  listAllCanvasDirEntries,
  refreshCanvasDirIndex,
} from '../storage/canvas-dirs.js';
import { parseFrontmatter } from '../storage/frontmatter.js';
import { getCanvasStore } from '../storage/index.js';
import {
  SPACE_JSON_FILENAME,
  WORLD_CANVAS_DIR_NAME,
} from '../storage/paths.js';
import { getWorkspacePath, isWorkspaceConfigured } from '../workspace.js';

import type { CanvasFile } from '../storage/index.js';
import type { ExternalNoteEvent, ExternalNoteItem } from '@sediment/shared';

type Listener = (event: ExternalNoteEvent) => void;

const INITIAL_SCAN_CONCURRENCY = 8;

const pendingByCanvas = new Map<string, Map<string, ExternalNoteItem>>();
const listenersByCanvas = new Map<string, Set<Listener>>();
const initialScansByCanvas = new Map<string, Promise<void>>();
let watcher: FSWatcher | null = null;
let nodeWatchers: NativeFSWatcher[] = [];
const pendingNodeEvents = new Map<string, NodeJS.Timeout>();

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
  for (const entry of listAllCanvasDirEntries()) {
    if (entry.filename === parts[0]) {
      return { canvasId: entry.id, relativePath: `nodes/${parts[2]}` };
    }
  }
  return null;
}

function noteIdsFromCanvas(canvas: CanvasFile | null): Set<string> {
  const ids = new Set<string>();
  if (!canvas) return ids;
  for (const n of canvas.state.nodes) {
    const id = (n as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function canvasNoteIds(canvasId: string): Set<string> {
  return noteIdsFromCanvas(getCanvasStore(canvasId).read());
}

async function readInitialCanvasNoteIds(absPath: string): Promise<Set<string>> {
  try {
    const canvasRoot = path.dirname(path.dirname(absPath));
    const raw = await readFile(
      path.join(canvasRoot, SPACE_JSON_FILENAME),
      'utf8',
    );
    return noteIdsFromCanvas(JSON.parse(raw) as CanvasFile);
  } catch {
    return new Set();
  }
}

function cachedInitialCanvasNoteIds(
  canvasId: string,
  absPath: string,
  cache: Map<string, Promise<Set<string>>>,
): Promise<Set<string>> {
  const cached = cache.get(canvasId);
  if (cached) return cached;
  const pending = readInitialCanvasNoteIds(absPath);
  cache.set(canvasId, pending);
  return pending;
}

async function buildItem(
  absPath: string,
  canvasId: string,
  relativePath: string,
  initialNoteIdsByCanvas?: Map<string, Promise<Set<string>>>,
): Promise<ExternalNoteItem | null> {
  try {
    const [raw, st] = await Promise.all([
      readFile(absPath, 'utf8'),
      stat(absPath),
    ]);
    const { meta } = parseFrontmatter(raw);
    const rawId = meta['id'];
    const noteId = typeof rawId === 'string' && rawId ? rawId : undefined;
    if (noteId) {
      const known = initialNoteIdsByCanvas
        ? await cachedInitialCanvasNoteIds(
            canvasId,
            absPath,
            initialNoteIdsByCanvas,
          )
        : canvasNoteIds(canvasId);
      if (known.has(noteId)) return null;
    }
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

async function addResolvedItem(
  absPath: string,
  canvasId: string,
  relativePath: string,
  initialNoteIdsByCanvas?: Map<string, Promise<Set<string>>>,
): Promise<void> {
  const item = await buildItem(
    absPath,
    canvasId,
    relativePath,
    initialNoteIdsByCanvas,
  );
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

function closeNodeWatchers(): void {
  for (const timer of pendingNodeEvents.values()) clearTimeout(timer);
  pendingNodeEvents.clear();
  for (const nodeWatcher of nodeWatchers) nodeWatcher.close();
  nodeWatchers = [];
}

function armNodeWatchers(): void {
  closeNodeWatchers();
  const ws = getWorkspacePath();
  for (const entry of listAllCanvasDirEntries()) {
    const nodesPath = path.join(ws, entry.filename, 'nodes');
    try {
      const nodeWatcher = watchFs(
        nodesPath,
        { persistent: true, encoding: 'utf8' },
        (_eventType, filename) => {
          if (!filename) return;
          const basename = path.basename(filename);
          if (basename !== filename || !basename.endsWith('.md')) return;
          const absPath = path.join(nodesPath, basename);
          const relativePath = `nodes/${basename}`;
          const pending = pendingNodeEvents.get(absPath);
          if (pending) clearTimeout(pending);
          pendingNodeEvents.set(
            absPath,
            setTimeout(() => {
              pendingNodeEvents.delete(absPath);
              void stat(absPath)
                .then((fileStat) => {
                  if (fileStat.isFile()) {
                    return addResolvedItem(absPath, entry.id, relativePath);
                  }
                })
                .catch(() => handleUnlink(absPath));
            }, 170),
          );
        },
      );
      nodeWatcher.on('error', (err: unknown) => {
        getLogger('external-note-watcher').warn(
          { err, nodesPath },
          'external note directory watcher error (ignored)',
        );
      });
      nodeWatchers.push(nodeWatcher);
    } catch (err) {
      getLogger('external-note-watcher').warn(
        { err, nodesPath },
        'external note directory watcher could not start (ignored)',
      );
    }
  }
}

async function closeWatcherHandles(): Promise<void> {
  const activeWatcher = watcher;
  watcher = null;
  closeNodeWatchers();
  if (activeWatcher) await activeWatcher.close().catch(() => undefined);
}

/**
 * Watch top-level Space lifecycle changes with Chokidar and note-directory
 * changes with native `fs.watch`, which registers without crawling existing
 * files. Pending state is left untouched so the caller decides whether a
 * fresh scan should clear it or preserve it across self-write suspension.
 */
function armWatcher(): void {
  if (!isWorkspaceConfigured()) return;
  const ws = getWorkspacePath();
  let initialScanComplete = false;
  const invalidateForTopLevelDirectory = (candidate: string): void => {
    if (!initialScanComplete) return;
    const relative = path.relative(path.resolve(ws), path.resolve(candidate));
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      return;
    }
    refreshCanvasDirIndex();
    armNodeWatchers();
  };
  armNodeWatchers();
  watcher = chokidar.watch(ws, {
    ignoreInitial: true,
    depth: 0,
    ignored: (candidate: string) => {
      const basename = path.basename(candidate);
      if (!basename.startsWith('.')) return false;
      return (
        path.resolve(candidate) !==
        path.join(path.resolve(ws), WORLD_CANVAS_DIR_NAME)
      );
    },
  });
  watcher
    .on('addDir', invalidateForTopLevelDirectory)
    .on('unlinkDir', invalidateForTopLevelDirectory)
    .on('ready', () => {
      initialScanComplete = true;
    })
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
    await closeWatcherHandles();
    pendingByCanvas.clear();
    initialScansByCanvas.clear();
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
    await closeWatcherHandles();
    pendingByCanvas.clear();
    initialScansByCanvas.clear();
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
    armAfterResume = watcher !== null || nodeWatchers.length > 0;
    await closeWatcherHandles();
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

async function scanExternalNotes(canvasId: string): Promise<void> {
  if (!isWorkspaceConfigured()) return;
  const entry = listAllCanvasDirEntries().find(
    (candidate) => candidate.id === canvasId,
  );
  if (!entry) return;
  const nodesPath = path.join(getWorkspacePath(), entry.filename, 'nodes');
  let notePaths: string[];
  try {
    const entries = await readdir(nodesPath, { withFileTypes: true });
    notePaths = entries
      .filter(
        (candidate) => candidate.isFile() && candidate.name.endsWith('.md'),
      )
      .map((candidate) => path.join(nodesPath, candidate.name));
  } catch {
    return;
  }

  const initialNoteIdsByCanvas = new Map<string, Promise<Set<string>>>();
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < notePaths.length) {
      const notePath = notePaths[nextIndex++];
      if (notePath) {
        await addResolvedItem(
          notePath,
          canvasId,
          `nodes/${path.basename(notePath)}`,
          initialNoteIdsByCanvas,
        );
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(INITIAL_SCAN_CONCURRENCY, notePaths.length) },
      () => worker(),
    ),
  );
}

export function ensureExternalNotesScanned(canvasId: string): Promise<void> {
  const existing = initialScansByCanvas.get(canvasId);
  if (existing) return existing;
  const pending = scanExternalNotes(canvasId);
  initialScansByCanvas.set(canvasId, pending);
  return pending;
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
