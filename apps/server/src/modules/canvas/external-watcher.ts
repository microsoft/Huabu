/**
 * @file External-note observation.
 *
 * Two ownership tiers, per `docs/architecture/canvas-storage.md`:
 *
 * - One depth-zero Chokidar watcher observes **Space lifecycle only** —
 *   top-level directory add/remove/rename. It never enumerates `nodes/`.
 * - One native `fs.watch` handle per **active Space session** observes
 *   `<Space>/nodes/`. A session exists only while at least one external-note
 *   SSE subscriber is attached, so watcher count scales with open streams
 *   rather than with total Space count. Inactive Spaces hold no watcher and
 *   no in-memory state; their eventual state is rebuilt by the first lazy
 *   scan when they are next opened.
 */

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

/** Upper bound on concurrent markdown reads inside one lazy Space scan. */
const INITIAL_SCAN_CONCURRENCY = 8;
/** Debounce applied to raw native events before `stat` + `readFile`. */
const NODE_EVENT_SETTLE_MS = 170;

export interface ExternalNoteSession {
  /** Merged initial state at acquisition time, newest first. */
  snapshot: ExternalNoteItem[];
  /**
   * Idempotent. The final release closes the Space's native watcher,
   * clears its pending timers, and drops its discovery state.
   */
  close(): void;
}

interface ActiveSpaceWatch {
  canvasId: string;
  nodesPath: string;
  watcher: NativeFSWatcher | null;
  listeners: Set<Listener>;
  /** Subscribers that acquired the session, including ones still scanning. */
  holders: number;
  pendingItems: Map<string, ExternalNoteItem>;
  pendingEvents: Map<string, NodeJS.Timeout>;
  /**
   * Paths a native event already resolved while the initial scan is in
   * flight. Non-null only during that window; scan results for these paths
   * are discarded so a live event always wins over an older observation.
   */
  scanOverrides: Set<string> | null;
  initialScan: Promise<void> | null;
  /** Set when a scan could not enumerate, so a later subscription retries. */
  scanFailed: boolean;
  /** Bumped on close and on workspace reset to reject stale async work. */
  sessionGeneration: number;
  closed: boolean;
}

const sessions = new Map<string, ActiveSpaceWatch>();
let watcher: FSWatcher | null = null;
let workspaceGeneration = 0;
let nextSessionGeneration = 1;

/**
 * Stamp identifying the workspace and session a piece of async work started
 * under. A slow cloud-drive read may resolve long after a workspace switch or
 * after the Space was closed and reopened; comparing stamps stops it from
 * repopulating unrelated state.
 */
function stampOf(session: ActiveSpaceWatch): string {
  return `${workspaceGeneration}:${session.sessionGeneration}`;
}

function isSessionCurrent(session: ActiveSpaceWatch, stamp?: string): boolean {
  if (session.closed) return false;
  if (sessions.get(session.canvasId) !== session) return false;
  return stamp === undefined || stamp === stampOf(session);
}

function nodesPathFor(canvasId: string): string | null {
  if (!isWorkspaceConfigured()) return null;
  const entry = listAllCanvasDirEntries().find(
    (candidate) => candidate.id === canvasId,
  );
  if (!entry) return null;
  return path.join(getWorkspacePath(), entry.filename, 'nodes');
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

async function readInitialCanvasNoteIds(
  nodesPath: string,
): Promise<Set<string>> {
  try {
    const raw = await readFile(
      path.join(path.dirname(nodesPath), SPACE_JSON_FILENAME),
      'utf8',
    );
    return noteIdsFromCanvas(JSON.parse(raw) as CanvasFile);
  } catch {
    return new Set();
  }
}

async function buildItem(
  absPath: string,
  relativePath: string,
  knownNoteIds: () => Promise<Set<string>>,
): Promise<ExternalNoteItem | null> {
  try {
    const [raw, st] = await Promise.all([
      readFile(absPath, 'utf8'),
      stat(absPath),
    ]);
    const { meta } = parseFrontmatter(raw);
    const rawId = meta['id'];
    const noteId = typeof rawId === 'string' && rawId ? rawId : undefined;
    if (noteId && (await knownNoteIds()).has(noteId)) return null;
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

function emit(session: ActiveSpaceWatch, event: ExternalNoteEvent): void {
  for (const fn of [...session.listeners]) {
    try {
      fn(event);
    } catch {
      /* ignore listener errors */
    }
  }
}

/** Idempotent by `relativePath`: a repeat observation replaces, never dupes. */
function recordItem(session: ActiveSpaceWatch, item: ExternalNoteItem): void {
  const existed = session.pendingItems.has(item.relativePath);
  session.pendingItems.set(item.relativePath, item);
  if (!existed) emit(session, { type: 'added', data: item });
}

function forgetItem(session: ActiveSpaceWatch, relativePath: string): void {
  if (!session.pendingItems.delete(relativePath)) return;
  emit(session, { type: 'removed', data: { relativePath } });
}

function snapshotOf(session: ActiveSpaceWatch): ExternalNoteItem[] {
  const known = canvasNoteIds(session.canvasId);
  const out: ExternalNoteItem[] = [];
  for (const [rel, item] of session.pendingItems) {
    if (item.noteId && known.has(item.noteId)) {
      session.pendingItems.delete(rel);
      continue;
    }
    out.push(item);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// ── Native `nodes/` watching (active Spaces only) ────────────────────────

function scheduleNodeEvent(session: ActiveSpaceWatch, basename: string): void {
  const relativePath = `nodes/${basename}`;
  const absPath = path.join(session.nodesPath, basename);
  const existing = session.pendingEvents.get(relativePath);
  if (existing) clearTimeout(existing);
  session.pendingEvents.set(
    relativePath,
    setTimeout(() => {
      session.pendingEvents.delete(relativePath);
      const stamp = stampOf(session);
      if (!isSessionCurrent(session, stamp)) return;
      // Claim authority over this path for the remainder of any in-flight
      // initial scan so a late scan read cannot resurrect or stale-overwrite.
      session.scanOverrides?.add(relativePath);
      void stat(absPath)
        .then(async (fileStat) => {
          if (!fileStat.isFile()) return;
          const item = await buildItem(absPath, relativePath, () =>
            Promise.resolve(canvasNoteIds(session.canvasId)),
          );
          if (!item || !isSessionCurrent(session, stamp)) return;
          recordItem(session, item);
        })
        .catch(() => {
          if (isSessionCurrent(session, stamp)) {
            forgetItem(session, relativePath);
          }
        });
    }, NODE_EVENT_SETTLE_MS),
  );
}

/**
 * Register the Space's native watcher. Failure is non-fatal: the caller still
 * gets a lazy snapshot, it simply will not receive live updates until the next
 * first subscription retries registration.
 */
function armSessionWatcher(session: ActiveSpaceWatch): void {
  if (session.watcher || !session.nodesPath) return;
  const { nodesPath } = session;
  try {
    const nativeWatcher = watchFs(
      nodesPath,
      { persistent: true, encoding: 'utf8' },
      (_eventType, filename) => {
        if (!filename) return;
        const basename = path.basename(filename);
        if (basename !== filename || !basename.endsWith('.md')) return;
        scheduleNodeEvent(session, basename);
      },
    );
    nativeWatcher.on('error', (err: unknown) => {
      getLogger('external-note-watcher').warn(
        { err, canvasId: session.canvasId, nodesPath },
        'external note directory watcher error (ignored)',
      );
    });
    session.watcher = nativeWatcher;
  } catch (err) {
    getLogger('external-note-watcher').warn(
      { err, canvasId: session.canvasId, nodesPath },
      'external note directory watcher could not start (ignored)',
    );
  }
}

function disarmSessionWatcher(session: ActiveSpaceWatch): void {
  for (const timer of session.pendingEvents.values()) clearTimeout(timer);
  session.pendingEvents.clear();
  session.watcher?.close();
  session.watcher = null;
}

function destroySession(session: ActiveSpaceWatch): void {
  if (session.closed) return;
  session.closed = true;
  disarmSessionWatcher(session);
  session.listeners.clear();
  session.pendingItems.clear();
  session.scanOverrides = null;
  session.initialScan = null;
  if (sessions.get(session.canvasId) === session) {
    sessions.delete(session.canvasId);
  }
}

/**
 * Re-point active sessions after the top-level directory index changed. A
 * renamed Space re-arms its watcher at the new path; a deleted Space drops its
 * live state and tells subscribers it is now empty. Inactive Spaces are
 * deliberately untouched — they own no watcher to fix up.
 */
function resyncActiveSessions(): void {
  for (const session of [...sessions.values()]) {
    const nodesPath = nodesPathFor(session.canvasId);
    if (!nodesPath) {
      disarmSessionWatcher(session);
      session.nodesPath = '';
      session.pendingItems.clear();
      session.initialScan = null;
      emit(session, { type: 'snapshot', data: { items: [] } });
      continue;
    }
    if (nodesPath === session.nodesPath && session.watcher) continue;
    disarmSessionWatcher(session);
    session.nodesPath = nodesPath;
    armSessionWatcher(session);
  }
}

async function closeWatcherHandles(): Promise<void> {
  const activeWatcher = watcher;
  watcher = null;
  for (const session of sessions.values()) disarmSessionWatcher(session);
  if (activeWatcher) await activeWatcher.close().catch(() => undefined);
}

/**
 * Arm the depth-zero workspace watcher plus the native watcher of every
 * currently active Space session. Discovery state is left untouched so the
 * caller decides whether a fresh scan should clear it or preserve it across
 * self-write suspension.
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
    resyncActiveSessions();
  };
  for (const session of sessions.values()) armSessionWatcher(session);
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
 * Tear every active session down and tell its subscribers the Space is now
 * empty. Called on workspace switch and shutdown: the previous workspace's
 * canvasIds are meaningless afterwards, and the client reconnects its stream
 * when it navigates into the new workspace.
 */
function destroyAllSessions(): void {
  for (const session of [...sessions.values()]) {
    emit(session, { type: 'snapshot', data: { items: [] } });
    destroySession(session);
  }
  sessions.clear();
}

/**
 * Stop the current watcher (if any), drop every active session, and re-arm
 * the workspace watcher against the currently active workspace. Safe to call
 * multiple times and from concurrent callers — transitions are serialized so
 * the module-level `watcher` reference is never overwritten before its handle
 * is closed. Bumping the workspace generation rejects any scan or event still
 * in flight from the previous workspace.
 */
export async function resetExternalNoteWatcher(): Promise<void> {
  return enqueueLifecycle(async () => {
    workspaceGeneration += 1;
    await closeWatcherHandles();
    destroyAllSessions();
    armWatcher();
  });
}

/**
 * Close the current watcher (if any) and drop every session *without*
 * re-arming. Call this from the server's shutdown path so live `fs.watch`
 * handles are released cleanly instead of being force-killed — on
 * virtual/network filesystems (Google Drive) a force-terminated process can
 * leave in-flight watch requests wedged. Serialized against
 * `resetExternalNoteWatcher` through the shared lifecycle chain.
 */
export async function closeExternalNoteWatcher(): Promise<void> {
  return enqueueLifecycle(async () => {
    workspaceGeneration += 1;
    await closeWatcherHandles();
    destroyAllSessions();
  });
}

// ── Self-write suspension ────────────────────────────────────────────────
//
// On Windows a live `fs.watch` handle anywhere inside a canvas subtree
// (the canvas dir itself OR its `nodes/` child) makes `renameSync` /
// `rmSync` of that directory fail with EPERM — the handle is persistent,
// so retries never win and `unwatch(subpath)` does not release it. The
// only fix is to fully `close()` the workspace watcher and every active
// session watcher for the duration of a server-owned directory
// rename/delete, then re-arm them.
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
 * directory so a live watch handle cannot block the filesystem operation on
 * Windows. Re-arming preserves each active session's discovery state:
 * external notes are keyed by `canvasId` + `relativePath`
 * (`nodes/<file>.md`), neither of which a directory rename changes, and
 * `recordItem` is idempotent — so the client's external-note list does not
 * flicker. A session whose Space was deleted inside the bracket is resynced
 * to an empty state instead.
 *
 * A no-op passthrough when nothing is currently armed (e.g. no workspace
 * configured, or a test harness), so it never spins up a watcher that was
 * intentionally absent.
 */
export async function runWithExternalNoteWatcherSuspended<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  if (suspendDepth === 0) {
    // Only re-arm on exit if something was actually running on entry.
    armAfterResume = watcher !== null || sessions.size > 0;
    await closeWatcherHandles();
  }
  suspendDepth++;
  try {
    return await fn();
  } finally {
    suspendDepth--;
    if (suspendDepth === 0 && armAfterResume) {
      armAfterResume = false;
      // While suspended we observed no events, so a Space renamed or deleted
      // inside the bracket must be reconciled explicitly: `resyncActiveSessions`
      // re-points survivors at their new directory and empties the rest.
      refreshCanvasDirIndex();
      resyncActiveSessions();
      armWatcher();
    }
  }
}

// ── Lazy initial discovery ───────────────────────────────────────────────

/**
 * Enumerate `<Space>/nodes/*.md` and merge the results into session state.
 * The native watcher is already armed by the caller, so an event observed
 * mid-scan is authoritative and wins over anything this scan reads.
 */
async function runInitialScan(session: ActiveSpaceWatch): Promise<void> {
  const stamp = stampOf(session);
  const overrides = new Set<string>();
  session.scanOverrides = overrides;
  try {
    let noteNames: string[];
    try {
      const entries = await readdir(session.nodesPath, { withFileTypes: true });
      noteNames = entries
        .filter(
          (candidate) => candidate.isFile() && candidate.name.endsWith('.md'),
        )
        .map((candidate) => candidate.name);
    } catch {
      // Do not cache a failed enumeration; a later subscription may retry.
      session.scanFailed = true;
      return;
    }
    if (!isSessionCurrent(session, stamp)) return;

    let topology: Promise<Set<string>> | null = null;
    const knownNoteIds = (): Promise<Set<string>> =>
      (topology ??= readInitialCanvasNoteIds(session.nodesPath));

    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      while (nextIndex < noteNames.length) {
        const name = noteNames[nextIndex++];
        if (!name) continue;
        const relativePath = `nodes/${name}`;
        const item = await buildItem(
          path.join(session.nodesPath, name),
          relativePath,
          knownNoteIds,
        );
        if (!isSessionCurrent(session, stamp)) return;
        if (!item || overrides.has(relativePath)) continue;
        recordItem(session, item);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(INITIAL_SCAN_CONCURRENCY, noteNames.length) },
        () => worker(),
      ),
    );
  } finally {
    if (session.scanOverrides === overrides) session.scanOverrides = null;
  }
}

async function ensureInitialScan(session: ActiveSpaceWatch): Promise<void> {
  let scan = session.initialScan;
  if (!scan) {
    session.scanFailed = false;
    scan = runInitialScan(session);
    session.initialScan = scan;
  }
  await scan;
  if (session.scanFailed && session.initialScan === scan) {
    session.initialScan = null;
  }
}

// ── Session acquisition ──────────────────────────────────────────────────

/**
 * Acquire a Space-scoped external-note session.
 *
 * The first subscriber arms the native watcher *before* enumeration begins,
 * which closes the ordinary scan-then-watch gap, then returns one merged
 * snapshot. Additional subscribers share that watcher and that scan.
 * `listener` starts receiving events only once its snapshot has been
 * produced, so it never sees an `added` event for an item the snapshot
 * already carries.
 *
 * Callers must invoke `close()` on every exit path, including a disconnect
 * that happens while the initial scan is still running.
 */
export async function openExternalNoteSession(
  canvasId: string,
  listener: Listener,
): Promise<ExternalNoteSession> {
  let session = sessions.get(canvasId);
  if (!session) {
    session = {
      canvasId,
      nodesPath: nodesPathFor(canvasId) ?? '',
      watcher: null,
      listeners: new Set(),
      holders: 0,
      pendingItems: new Map(),
      pendingEvents: new Map(),
      scanOverrides: null,
      initialScan: null,
      scanFailed: false,
      sessionGeneration: nextSessionGeneration++,
      closed: false,
    };
    sessions.set(canvasId, session);
    armSessionWatcher(session);
  }

  const active = session;
  active.holders += 1;
  let released = false;
  const close = (): void => {
    if (released) return;
    released = true;
    active.listeners.delete(listener);
    active.holders -= 1;
    if (active.holders <= 0) destroySession(active);
  };

  if (active.nodesPath) await ensureInitialScan(active);

  // Registering the listener and reading the snapshot must stay in one
  // synchronous block so no event can slip between them.
  if (released || !isSessionCurrent(active)) return { snapshot: [], close };
  active.listeners.add(listener);
  return { snapshot: snapshotOf(active), close };
}

/** Remove and return a pending item — used by the import endpoint. */
export function takeExternalNote(
  canvasId: string,
  relativePath: string,
): ExternalNoteItem | null {
  const session = sessions.get(canvasId);
  if (!session) return null;
  const item = session.pendingItems.get(relativePath) ?? null;
  if (item) session.pendingItems.delete(relativePath);
  return item;
}
