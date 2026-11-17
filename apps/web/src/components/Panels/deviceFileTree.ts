// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Loading and expansion state for the Files panel's directory tree.
 *
 * Kept outside React so that one object owns every request: it bounds how
 * many run at once, cancels them when they stop mattering, and decides which
 * replies are still current. The panel only renders the snapshot.
 */

import { listDeviceFiles } from '@/api/device-files';

import type { FileListResult } from '@huabu/shared';

export type FileEntry = FileListResult['entries'][number];
type FilePages = Readonly<Record<string, FileListResult>>;
type FileTreeRow =
  | { entry: FileEntry; depth: number; relativePath: string }
  | { more: string; depth: number };

type FileTreeError =
  /** The directory being opened could not be listed. */
  | { kind: 'root'; path: string; message?: string }
  /** A folder inside the tree could not be listed. */
  | { kind: 'folder'; message?: string }
  | { kind: 'limit' };

type FileTreeSnapshot = {
  /** Directory on screen; lags the requested one until its listing arrives. */
  root: string | null;
  pages: FilePages;
  expanded: ReadonlySet<string>;
  /** Folders whose own listing is in flight. */
  loading: ReadonlySet<string>;
  /** The root, together with every open folder, is being re-listed. */
  reloading: boolean;
  error: FileTreeError | null;
};

const MAX_TREE_ENTRIES = 2000;
const MAX_TREE_DEPTH = 32;
/**
 * The server rejects a device's ninth pending filesystem request. Staying
 * well under that leaves room for file previews reading from the same device.
 */
const MAX_CONCURRENT_REQUESTS = 4;

const EMPTY: FileTreeSnapshot = {
  root: null,
  pages: {},
  expanded: new Set(),
  loading: new Set(),
  reloading: false,
  error: null,
};

type ListFiles = typeof listDeviceFiles;

const countEntries = (pages: FilePages) =>
  Object.values(pages).reduce((total, page) => total + page.entries.length, 0);

const messageOf = (failure: unknown) =>
  failure instanceof Error ? failure.message : undefined;

/** Expanded directories still reachable from `root` through loaded pages. */
function reachableExpanded(
  root: string,
  pages: FilePages,
  expanded: ReadonlySet<string>,
) {
  const reachable = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth >= MAX_TREE_DEPTH) return;
    for (const entry of pages[directory]?.entries ?? []) {
      if (
        entry.kind !== 'directory' ||
        !expanded.has(entry.path) ||
        !pages[entry.path] ||
        reachable.has(entry.path)
      )
        continue;
      reachable.add(entry.path);
      visit(entry.path, depth + 1);
    }
  };
  visit(root, 0);
  return reachable;
}

/** Flatten the open part of the tree into the rows the list renders. */
export function buildFileTreeRows(snapshot: FileTreeSnapshot): FileTreeRow[] {
  const { root, pages, expanded } = snapshot;
  if (!root) return [];
  const rows: FileTreeRow[] = [];
  const visited = new Set<string>();
  const separator = pages[root]?.path.startsWith('/') ? '/' : '\\';
  const visit = (directory: string, depth: number, parent: string) => {
    if (visited.has(directory) || depth > MAX_TREE_DEPTH) return;
    visited.add(directory);
    const page = pages[directory];
    for (const entry of page?.entries ?? []) {
      const relativePath = parent
        ? `${parent}${separator}${entry.name}`
        : entry.name;
      rows.push({ entry, depth, relativePath });
      if (entry.kind === 'directory' && expanded.has(entry.path))
        visit(entry.path, depth + 1, relativePath);
    }
    if (page?.nextCursor) rows.push({ more: directory, depth });
  };
  visit(root, 0, '');
  return rows;
}

export class DeviceFileTree {
  private snapshot = EMPTY;
  private readonly listeners = new Set<() => void>();

  private agentletId: string | null = null;
  private path: string | null = null;
  private showHidden = false;

  /** Cancels everything requested for the current device and visibility. */
  private session = new AbortController();
  /** Cancels the reload in flight; a newer reload replaces it. */
  private reload: AbortController | null = null;
  /** Folders listed while a reload was in flight; they are already fresh. */
  private freshSinceReload = new Set<string>();

  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly list: ListFiles = listDeviceFiles) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.snapshot;

  /**
   * Show `path` on a device. The previous listing stays on screen until the
   * new one arrives, unless it belongs to another device.
   */
  open(agentletId: string, path: string, showHidden: boolean): void {
    const sameDevice = agentletId === this.agentletId;
    if (!sameDevice || showHidden !== this.showHidden) {
      // Replies requested under the old device or visibility are now wrong.
      this.endSession();
      this.update({ loading: new Set() });
    }
    if (!sameDevice) this.update({ ...EMPTY });
    this.agentletId = agentletId;
    this.path = path;
    this.showHidden = showHidden;
    void this.reloadTree();
  }

  /** Re-list the current directory and every open folder in place. */
  refresh(): void {
    if (this.agentletId && this.path) void this.reloadTree();
  }

  /** Stop all work and forget the tree. */
  close(): void {
    this.endSession();
    this.agentletId = null;
    this.path = null;
    this.update({ ...EMPTY });
  }

  /** Keep `directory` open the next time it appears, e.g. after going up. */
  keepOpen(directory: string): void {
    this.update({ expanded: new Set(this.snapshot.expanded).add(directory) });
  }

  /** Open or close a folder row, listing it the first time. */
  toggle(directory: string, depth: number): void {
    if (depth >= MAX_TREE_DEPTH) {
      this.update({ error: { kind: 'limit' } });
      return;
    }
    if (!this.snapshot.pages[directory]) {
      void this.loadFolder(directory);
      return;
    }
    const expanded = new Set(this.snapshot.expanded);
    if (!expanded.delete(directory)) expanded.add(directory);
    this.update({ expanded });
  }

  /** Fetch the next page of a partially listed folder. */
  loadMore(directory: string): void {
    const cursor = this.snapshot.pages[directory]?.nextCursor;
    if (cursor) void this.loadFolder(directory, cursor);
  }

  /** Cancel every request in flight, folder listings and reload alike. */
  private endSession(): void {
    this.session.abort();
    this.session = new AbortController();
    this.reload?.abort();
    this.reload = null;
  }

  private update(patch: Partial<FileTreeSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Run `request` once a slot is free, unless it was cancelled meanwhile. */
  private async queued<T>(
    signal: AbortSignal,
    request: () => Promise<T>,
  ): Promise<T> {
    if (this.running >= MAX_CONCURRENT_REQUESTS)
      await new Promise<void>((resume) => this.waiting.push(resume));
    else this.running++;
    // A resumed waiter inherits the slot of the request that woke it.
    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return await request();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  private async reloadTree(): Promise<void> {
    const { agentletId, path, showHidden } = this;
    if (!agentletId || !path) return;
    this.reload?.abort();
    const reload = new AbortController();
    this.reload = reload;
    const { signal } = reload;
    this.freshSinceReload = new Set();
    this.update({ reloading: true, error: null });

    const directories = [
      path,
      ...[...this.snapshot.expanded].filter((directory) => directory !== path),
    ];
    const results = await Promise.allSettled(
      directories.map((directory) =>
        this.queued(signal, () =>
          this.list(agentletId, { path: directory, showHidden }, signal),
        ),
      ),
    );
    if (signal.aborted) return;
    this.reload = null;

    const rootResult = results[0];
    if (rootResult?.status !== 'fulfilled') {
      this.update({
        reloading: false,
        error: { kind: 'root', path, message: messageOf(rootResult?.reason) },
        // A failed refresh keeps the listing; a failed navigation must not
        // leave another directory on screen.
        ...(this.snapshot.root === path
          ? {}
          : { root: null, pages: {}, expanded: new Set<string>() }),
      });
      return;
    }

    const fetched: Record<string, FileListResult> = {};
    let total = 0;
    let limited = false;
    results.forEach((result, index) => {
      const directory = directories[index];
      if (result.status !== 'fulfilled' || directory === undefined) return;
      if (total + result.value.entries.length > MAX_TREE_ENTRIES) {
        limited = true;
        return;
      }
      total += result.value.entries.length;
      fetched[directory] = result.value;
    });
    for (const directory of this.freshSinceReload) {
      const page = this.snapshot.pages[directory];
      if (page && !fetched[directory]) fetched[directory] = page;
    }
    // Drop folders that vanished, failed, or are no longer under this root.
    const expanded = reachableExpanded(path, fetched, this.snapshot.expanded);
    const pages: Record<string, FileListResult> = {};
    for (const directory of [path, ...expanded]) {
      const page = fetched[directory];
      if (page) pages[directory] = page;
    }
    this.update({
      root: path,
      pages,
      expanded,
      reloading: false,
      error: limited ? { kind: 'limit' } : null,
    });
  }

  private async loadFolder(directory: string, cursor?: string): Promise<void> {
    const { agentletId, showHidden } = this;
    if (!agentletId || this.snapshot.loading.has(directory)) return;
    if (countEntries(this.snapshot.pages) >= MAX_TREE_ENTRIES) {
      this.update({ error: { kind: 'limit' } });
      return;
    }
    const { signal } = this.session;
    this.update({
      loading: new Set(this.snapshot.loading).add(directory),
      error: null,
    });
    try {
      const result = await this.queued(signal, () =>
        this.list(
          agentletId,
          { path: directory, showHidden, ...(cursor ? { cursor } : {}) },
          signal,
        ),
      );
      if (signal.aborted) return;
      const { pages, expanded } = this.snapshot;
      if (countEntries(pages) + result.entries.length > MAX_TREE_ENTRIES) {
        this.update({ error: { kind: 'limit' } });
        return;
      }
      // Paging can overlap when the directory changed between requests.
      const entries = cursor
        ? [
            ...new Map(
              [...(pages[directory]?.entries ?? []), ...result.entries].map(
                (entry) => [entry.path, entry],
              ),
            ).values(),
          ]
        : result.entries;
      this.freshSinceReload.add(directory);
      this.update({
        pages: { ...pages, [directory]: { ...result, entries } },
        expanded: new Set(expanded).add(directory),
      });
    } catch (failure) {
      if (!signal.aborted)
        this.update({
          error: { kind: 'folder', message: messageOf(failure) },
        });
    } finally {
      // A new session starts with an empty set; leave it alone.
      if (!signal.aborted) {
        const loading = new Set(this.snapshot.loading);
        loading.delete(directory);
        this.update({ loading });
      }
    }
  }
}
