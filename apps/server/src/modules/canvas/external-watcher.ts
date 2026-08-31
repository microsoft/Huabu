// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file External-note observation.
 *
 * Exists for exactly one product feature: surfacing user-authored `.md` files
 * dropped into `<Space>/nodes/` from outside the app so the layer panel can
 * offer them for import.
 *
 * At most one native `fs.watch` handle per **active Space session** observes
 * `<Space>/nodes/` in steady state. Subscribers to the same Space share that
 * session, so watcher count follows distinct active Spaces, not open streams.
 * Inactive Spaces hold no watcher and no in-memory state; their eventual state
 * is rebuilt by the first lazy scan when they are next opened. There is no
 * workspace-level watcher: `canvas-dirs.ts` invalidates its directory index
 * lazily on the read paths that need it.
 *
 * Because a live handle blocks `renameSync` / `rmSync` on Windows, each
 * session registers itself with `space-dir-handles.ts` so a server-owned
 * rename or delete of that Space can release and re-acquire it.
 */

import {
  statSync,
  watch as watchFs,
  type FSWatcher as NativeFSWatcher,
  type Stats,
} from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { getLogger } from '../../utils/logger.js';
import { parseFrontmatter } from '../../utils/markdown-frontmatter.js';
import { listAllCanvasDirEntries } from '../storage/canvas-dirs.js';
import { space } from '../storage/index.js';
import { registerSpaceDirHandleOwner } from '../storage/index.js';
import { getWorkspacePath, isWorkspaceConfigured } from '../workspace.js';

import type { CanvasFile } from '../storage/index.js';
import type { ExternalNoteEvent, ExternalNoteItem } from '@huabu/shared';

type Listener = (event: ExternalNoteEvent) => void;

/** Upper bound on concurrent markdown reads inside one lazy Space scan. */
const INITIAL_SCAN_CONCURRENCY = 8;
/** Debounce applied to raw native events before `stat` + `readFile`. */
const NODE_EVENT_SETTLE_MS = 170;
/** Windows fallback while `nodes/` is absent; avoids locking the Space root. */
const MISSING_NODES_POLL_MS = 1_000;

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
  /** True while the Space root is watched for a not-yet-created `nodes/`. */
  watchingParent: boolean;
  /** True while Windows probes for `nodes/` without holding a directory handle. */
  pollingForNodes: boolean;
  /** Coalesces identity/existence checks and owns the Windows probe timer. */
  nodesProbeTimer: NodeJS.Timeout | null;
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

async function canvasNoteIds(canvasId: string): Promise<Set<string>> {
  return noteIdsFromCanvas(await space(canvasId).read());
}

/**
 * The scan's view of which notes the Space already knows.
 *
 * Read through the port rather than off the record file beside `nodes/`. The
 * path read was equivalent only because Disk keeps the two together, and this
 * question — what does the Space contain — is one every backend answers.
 * Failure degrades to "knows nothing", as before: a scan that cannot read
 * topology surfaces every file rather than silently hiding some.
 */
async function readInitialCanvasNoteIds(
  canvasId: string,
): Promise<Set<string>> {
  try {
    return await canvasNoteIds(canvasId);
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

/**
 * `known` is passed in rather than read here because this must stay
 * synchronous: it both reads and prunes `pendingItems`, and the caller relies
 * on registering its listener and taking the snapshot without an await
 * between them, so no event can slip through.
 */
function snapshotOf(
  session: ActiveSpaceWatch,
  known: ReadonlySet<string>,
): ExternalNoteItem[] {
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
            canvasNoteIds(session.canvasId),
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

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function directoryIdentity(
  st: Pick<Stats, 'dev' | 'ino' | 'birthtimeMs'>,
): string {
  return `${st.dev}:${st.ino}:${st.birthtimeMs}`;
}

function isWaitingForNodes(session: ActiveSpaceWatch): boolean {
  return session.watchingParent || session.pollingForNodes;
}

function scanNewNodesDirectory(session: ActiveSpaceWatch): void {
  session.scanFailed = false;
  session.initialScan = null;
  void ensureInitialScan(session).catch((err: unknown) => {
    getLogger('external-note-watcher').warn(
      { err, canvasId: session.canvasId, nodesPath: session.nodesPath },
      'external note initial scan after directory creation failed (ignored)',
    );
  });
}

/** Reset a stale child watcher and wait for the current `nodes/` path. */
function recoverDeletedNodesDirectory(
  session: ActiveSpaceWatch,
  staleWatcher: NativeFSWatcher,
): void {
  if (
    !isSessionCurrent(session) ||
    isWaitingForNodes(session) ||
    session.watcher !== staleWatcher
  ) {
    return;
  }

  // Invalidate scans/events tied to the deleted inode before rearming. The
  // same session and subscribers survive; only its discovered filesystem
  // state is reset.
  session.sessionGeneration = nextSessionGeneration++;
  disarmSessionWatcher(session);
  session.pendingItems.clear();
  session.scanOverrides = null;
  session.initialScan = null;
  session.scanFailed = false;
  emit(session, { type: 'snapshot', data: { items: [] } });

  armSessionWatcher(session);
  if (session.watcher && !isWaitingForNodes(session)) {
    scanNewNodesDirectory(session);
  }
}

async function verifyNodesWatcherIdentity(
  session: ActiveSpaceWatch,
  staleWatcher: NativeFSWatcher,
  watchedIdentity: string,
): Promise<void> {
  const stamp = stampOf(session);
  let current: Awaited<ReturnType<typeof stat>>;
  try {
    current = await stat(session.nodesPath);
  } catch (err) {
    if (isMissingPathError(err)) {
      if (
        isSessionCurrent(session, stamp) &&
        session.watcher === staleWatcher
      ) {
        // A Finder-side Space rename moves `nodes/` with the Space. Re-resolve
        // by canvasId before rearming so the active session follows it.
        session.nodesPath = nodesPathFor(session.canvasId) ?? session.nodesPath;
      }
      recoverDeletedNodesDirectory(session, staleWatcher);
    } else {
      getLogger('external-note-watcher').warn(
        { err, canvasId: session.canvasId, nodesPath: session.nodesPath },
        'external note directory identity could not be verified (ignored)',
      );
    }
    return;
  }

  if (
    !isSessionCurrent(session, stamp) ||
    session.watcher !== staleWatcher ||
    isWaitingForNodes(session)
  ) {
    return;
  }
  if (
    !current.isDirectory() ||
    directoryIdentity(current) !== watchedIdentity
  ) {
    recoverDeletedNodesDirectory(session, staleWatcher);
  }
}

function scheduleNodesWatcherIdentityCheck(
  session: ActiveSpaceWatch,
  staleWatcher: NativeFSWatcher,
  watchedIdentity: string,
): void {
  if (session.nodesProbeTimer) clearTimeout(session.nodesProbeTimer);
  session.nodesProbeTimer = setTimeout(() => {
    session.nodesProbeTimer = null;
    if (
      !isSessionCurrent(session) ||
      session.watcher !== staleWatcher ||
      isWaitingForNodes(session)
    ) {
      return;
    }
    void verifyNodesWatcherIdentity(session, staleWatcher, watchedIdentity);
  }, NODE_EVENT_SETTLE_MS);
}

function createNodesWatcher(
  session: ActiveSpaceWatch,
  nodesPath: string,
): NativeFSWatcher {
  let watchedIdentity = '';
  const nativeWatcher = watchFs(
    nodesPath,
    { persistent: true, encoding: 'utf8' },
    (eventType, filename) => {
      // Native watchers stay attached to the deleted inode on platforms such
      // as Linux. Self-renames and filename-less events are ambiguous, so
      // verify the watched directory identity before resetting session state.
      if (
        !filename ||
        (eventType === 'rename' &&
          path.basename(filename) === path.basename(nodesPath))
      ) {
        scheduleNodesWatcherIdentityCheck(
          session,
          nativeWatcher,
          watchedIdentity,
        );
        return;
      }
      const basename = path.basename(filename);
      if (basename !== filename || !basename.endsWith('.md')) return;
      scheduleNodeEvent(session, basename);
    },
  );
  try {
    const current = statSync(nodesPath);
    if (!current.isDirectory()) {
      throw Object.assign(new Error('nodes path is not a directory'), {
        code: 'ENOTDIR',
      });
    }
    watchedIdentity = directoryIdentity(current);
  } catch (err) {
    nativeWatcher.close();
    throw err;
  }
  nativeWatcher.on('error', (err: unknown) => {
    getLogger('external-note-watcher').warn(
      { err, canvasId: session.canvasId, nodesPath },
      'external note directory watcher error (ignored)',
    );
  });
  return nativeWatcher;
}

/**
 * Promote a temporary Space-root watcher or Windows probe to `nodes/`.
 *
 * A parent handle remains live until the child handle has opened. Windows uses
 * a single periodic probe instead because a Space-root handle blocks external
 * rename.
 */
function promoteWaitingNodesWatcher(session: ActiveSpaceWatch): void {
  if (!isSessionCurrent(session) || !isWaitingForNodes(session)) return;
  const parentWatcher = session.watchingParent ? session.watcher : null;
  let nodesWatcher: NativeFSWatcher;
  try {
    nodesWatcher = createNodesWatcher(session, session.nodesPath);
  } catch (err) {
    // The directory can disappear during promotion. A parent watcher remains
    // armed; a Windows polling session schedules its next probe below.
    if (!isMissingPathError(err)) {
      getLogger('external-note-watcher').warn(
        { err, canvasId: session.canvasId, nodesPath: session.nodesPath },
        'external note directory watcher could not start (ignored)',
      );
    }
    if (session.pollingForNodes) {
      scheduleNodesDirectoryProbe(session, MISSING_NODES_POLL_MS);
    }
    return;
  }

  if (!isSessionCurrent(session) || !isWaitingForNodes(session)) {
    nodesWatcher.close();
    return;
  }
  session.watcher = nodesWatcher;
  session.watchingParent = false;
  session.pollingForNodes = false;
  parentWatcher?.close();

  // The original acquisition returned an empty snapshot while `nodes/` was
  // absent. Scan once now; recordItem emits files that landed during handoff.
  scanNewNodesDirectory(session);
}

async function probeNodesDirectory(session: ActiveSpaceWatch): Promise<void> {
  const stamp = stampOf(session);
  try {
    const current = await stat(session.nodesPath);
    if (
      current.isDirectory() &&
      isSessionCurrent(session, stamp) &&
      isWaitingForNodes(session)
    ) {
      promoteWaitingNodesWatcher(session);
    }
  } catch {
    // Still absent. The parent watcher or periodic Windows probe retries.
    if (isSessionCurrent(session, stamp) && session.pollingForNodes) {
      session.nodesPath = nodesPathFor(session.canvasId) ?? session.nodesPath;
    }
  } finally {
    if (
      isSessionCurrent(session, stamp) &&
      session.pollingForNodes &&
      !session.nodesProbeTimer
    ) {
      scheduleNodesDirectoryProbe(session, MISSING_NODES_POLL_MS);
    }
  }
}

function scheduleNodesDirectoryProbe(
  session: ActiveSpaceWatch,
  delay = NODE_EVENT_SETTLE_MS,
): void {
  if (session.nodesProbeTimer) clearTimeout(session.nodesProbeTimer);
  session.nodesProbeTimer = setTimeout(() => {
    session.nodesProbeTimer = null;
    if (!isSessionCurrent(session) || !isWaitingForNodes(session)) return;
    void probeNodesDirectory(session);
  }, delay);
}

/**
 * Register the Space's native watcher. Failure is non-fatal: the caller still
 * gets a lazy snapshot, it simply will not receive live updates until the next
 * first subscription retries registration.
 */
function armSessionWatcher(session: ActiveSpaceWatch): void {
  if (session.watcher || session.pollingForNodes || !session.nodesPath) return;
  const { nodesPath } = session;
  try {
    session.watcher = createNodesWatcher(session, nodesPath);
    session.watchingParent = false;
    session.pollingForNodes = false;
    return;
  } catch (err) {
    if (!isMissingPathError(err)) {
      getLogger('external-note-watcher').warn(
        { err, canvasId: session.canvasId, nodesPath },
        'external note directory watcher could not start (ignored)',
      );
      return;
    }
  }

  // A Space-root fs.watch handle blocks external rename/delete on Windows.
  // Probe only while this active session is missing `nodes/`; the final close
  // cancels the timer, and successful creation promotes to the child watcher.
  if (process.platform === 'win32') {
    session.pollingForNodes = true;
    scheduleNodesDirectoryProbe(session);
    return;
  }

  // A valid existing Space need not have written a sidecar yet, so `nodes/`
  // may legitimately be absent. Watch the existing Space root for its first
  // appearance instead of logging/retrying ENOENT on every subscription.
  const spacePath = path.dirname(nodesPath);
  try {
    const parentWatcher = watchFs(
      spacePath,
      { persistent: true, encoding: 'utf8' },
      (_eventType, filename) => {
        if (!filename || path.basename(filename) !== path.basename(nodesPath)) {
          return;
        }
        scheduleNodesDirectoryProbe(session);
      },
    );
    parentWatcher.on('error', (err: unknown) => {
      getLogger('external-note-watcher').warn(
        { err, canvasId: session.canvasId, nodesPath, spacePath },
        'external note Space watcher error (ignored)',
      );
    });
    session.watcher = parentWatcher;
    session.watchingParent = true;
    session.pollingForNodes = false;
    // Close the narrow race where `nodes/` appeared after the failed child
    // watch but before the parent handle was registered.
    void probeNodesDirectory(session);
  } catch (err) {
    getLogger('external-note-watcher').warn(
      { err, canvasId: session.canvasId, nodesPath, spacePath },
      'external note Space watcher could not start (ignored)',
    );
  }
}

function disarmSessionWatcher(session: ActiveSpaceWatch): void {
  for (const timer of session.pendingEvents.values()) clearTimeout(timer);
  session.pendingEvents.clear();
  if (session.nodesProbeTimer) clearTimeout(session.nodesProbeTimer);
  session.nodesProbeTimer = null;
  session.watcher?.close();
  session.watcher = null;
  session.watchingParent = false;
  session.pollingForNodes = false;
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
  if (
    nodesPath === session.nodesPath &&
    (session.watcher || session.pollingForNodes)
  ) {
    return;
  }
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
      (topology ??= readInitialCanvasNoteIds(session.canvasId));

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
      watchingParent: false,
      pollingForNodes: false,
      nodesProbeTimer: null,
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

  // A session whose `nodes/` does not exist holds a parent watcher (or a
  // Windows probe) and an empty snapshot. It promotes itself and performs one
  // scan when the directory appears; subscribers share the same wait state.
  if (!active.watcher && !active.pollingForNodes && active.nodesPath) {
    armSessionWatcher(active);
  }
  if (active.nodesPath && !isWaitingForNodes(active)) {
    await ensureInitialScan(active);
  }

  const known = await canvasNoteIds(active.canvasId);

  // Registering the listener and reading the snapshot must stay in one
  // synchronous block so no event can slip between them.
  if (released || !isSessionCurrent(active)) return { snapshot: [], close };
  active.listeners.add(listener);
  return { snapshot: snapshotOf(active, known), close };
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
