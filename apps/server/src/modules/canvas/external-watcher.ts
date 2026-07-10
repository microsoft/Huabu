import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import chokidar, { type FSWatcher } from 'chokidar';

import { getLogger } from '../../utils/logger.js';
import {
  listCanvasDirEntries,
  refreshCanvasDirIndex,
} from '../storage/canvas-dirs.js';
import { parseFrontmatter } from '../storage/frontmatter.js';
import { getCanvasStore } from '../storage/index.js';
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
  for (const entry of listCanvasDirEntries()) {
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
 * Stop the current watcher (if any), drop pending state, and re-arm it
 * against the currently active workspace. Safe to call multiple times.
 * Listeners are preserved so reconnected clients keep their streams.
 */
export async function resetExternalNoteWatcher(): Promise<void> {
  if (watcher) {
    await watcher.close().catch(() => undefined);
    watcher = null;
  }
  pendingByCanvas.clear();

  if (!isWorkspaceConfigured()) return;
  const ws = getWorkspacePath();
  // chokidar v5 removed glob support, so watch the workspace root and
  // filter via `ignored` + `resolvePath()` in the event handlers. Depth
  // is capped at 2 so we never descend into `nodes/` siblings or
  // hidden subdirs by accident.
  watcher = chokidar.watch(ws, {
    ignoreInitial: false,
    depth: 2,
    ignored: (p: string) => path.basename(p).startsWith('.'),
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
