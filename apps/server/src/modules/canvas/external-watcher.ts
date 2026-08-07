/**
 * @file External-note observation.
 *
 * Exists for exactly one product feature: surfacing user-authored `.md` files
 * dropped into `<Space>/nodes/` from outside the app so the layer panel can
 * offer them for import.
 *
 * One native `fs.watch` handle per **active Space session** observes
 * `<Space>/nodes/`. A session exists only while at least one external-note SSE
 * subscriber is attached, so watcher count equals the number of open streams.
 * Inactive Spaces hold no watcher and no in-memory state; their eventual state
 * is rebuilt by the first lazy scan when they are next opened. There is no
 * workspace-level watcher: `canvas-dirs.ts` invalidates its directory index
 * lazily on the read paths that need it.
 *
 * Because a live handle blocks `renameSync` / `rmSync` on Windows, each
 * session registers itself with `space-dir-handles.ts` so a server-owned
 * rename or delete of that Space can release and re-acquire it.
 */

import { watch as watchFs, type FSWatcher as NativeFSWatcher } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { getLogger } from '../../utils/logger.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import { listAllCanvasDirEntries } from '../storage/canvas-dirs.js';
import { getCanvasStore } from '../storage/index.js';
import { SPACE_JSON_FILENAME } from '../storage/paths.js';
import { registerSpaceDirHandleOwner } from '../workspace/disk/space-dir-handles.js';
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
  /** Deregisters the session from `space-dir-handles.ts`. */
  unregisterHandleOwner: () => void;
  closed: boolean;
}

const sessions = new Map<string, ActiveSpaceWatch>();
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
  session.unregisterHandleOwner();
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
 * Re-point a session at its Space directory, which a server-owned mutation
 * may have renamed or deleted. A survivor re-arms its watcher at the new path;
 * a deleted Space drops its live state and tells subscribers it is now empty.
 * Idempotent, so it doubles as the handle-owner `reacquire` hook.
 */
function resyncSession(session: ActiveSpaceWatch): void {
  if (session.closed) return;
  const nodesPath = nodesPathFor(session.canvasId);
  if (!nodesPath) {
    disarmSessionWatcher(session);
    session.nodesPath = '';
    session.pendingItems.clear();
    session.initialScan = null;
    emit(session, { type: 'snapshot', data: { items: [] } });
    return;
  }
  if (nodesPath === session.nodesPath && session.watcher) return;
  disarmSessionWatcher(session);
  session.nodesPath = nodesPath;
  armSessionWatcher(session);
}

/**
 * Tear every active session down and tell its subscribers the Space is now
 * empty. Called on workspace switch and shutdown: the previous workspace's
 * canvasIds are meaningless afterwards, and the client reconnects its stream
 * when it navigates into the new workspace. Bumping the workspace generation
 * rejects any scan or event still in flight from the previous workspace.
 */
function destroyAllSessions(): void {
  for (const session of [...sessions.values()]) {
    emit(session, { type: 'snapshot', data: { items: [] } });
    destroySession(session);
  }
  sessions.clear();
}

/**
 * Drop every active external-note session and release its handles.
 *
 * Called on workspace switch (the previous workspace's canvasIds are
 * meaningless afterwards, and the client reconnects its stream when it
 * navigates into the new workspace) and on server shutdown, so live
 * `fs.watch` handles are released cleanly instead of being force-killed —
 * on virtual/network filesystems (Google Drive) a force-terminated process
 * can leave in-flight watch requests wedged.
 *
 * Synchronous and idempotent: there is no workspace-level watcher to close,
 * so no lifecycle serialization is required.
 */
export function resetExternalNoteSessions(): void {
  workspaceGeneration += 1;
  destroyAllSessions();
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
    const created: ActiveSpaceWatch = {
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
      unregisterHandleOwner: () => undefined,
      closed: false,
    };
    session = created;
    sessions.set(canvasId, created);
    // Declare the handle so a server-owned rename/delete of this Space can
    // release it; `resyncSession` re-resolves the directory on re-acquire.
    created.unregisterHandleOwner = registerSpaceDirHandleOwner(canvasId, {
      release: () => disarmSessionWatcher(created),
      reacquire: () => resyncSession(created),
    });
    armSessionWatcher(created);
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
