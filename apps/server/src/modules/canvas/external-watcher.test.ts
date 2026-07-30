/**
 * @file Tests for the external-note watcher's two ownership tiers: the
 * depth-zero workspace chokidar watcher that observes Space lifecycle only,
 * and the per-active-Space native `nodes/` watcher owned by an external-note
 * SSE session. Also covers `runWithExternalNoteWatcherSuspended` — the
 * depth-counted bracket that fully closes every live handle for the duration
 * of a server-owned canvas rename/delete (so a live `fs.watch` handle cannot
 * block `renameSync` / `rmSync` with EPERM on Windows) and then re-arms it.
 *
 * chokidar, `node:fs`, and the workspace resolver are mocked so the module can
 * be exercised without a real filesystem: `chokidar.watch` returns a fake
 * `FSWatcher` and the workspace is toggled on/off per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ configured: true }));

const fileIO = vi.hoisted(() => ({
  readFile: vi.fn(async (filePath: string) =>
    filePath.endsWith('space.json')
      ? JSON.stringify({ state: { nodes: [] } })
      : '---\nid: external-note\n---\n',
  ),
  readdir: vi.fn<() => Promise<Array<{ name: string; isFile: () => boolean }>>>(
    async () => [],
  ),
  stat: vi.fn(async () => ({ mtimeMs: 1, isFile: () => true })),
}));

vi.mock('node:fs/promises', () => fileIO);

const nativeWatchMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  watch: nativeWatchMock,
}));

const watchMock = vi.hoisted(() => vi.fn());

vi.mock('chokidar', () => ({
  default: { watch: watchMock },
}));

vi.mock('../workspace.js', () => ({
  isWorkspaceConfigured: () => state.configured,
  getWorkspacePath: () => '/ws',
}));

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

// Spy on the canvas-dir index so the delete-cleanup prune step on re-arm is
// observable (it refreshes the index and enumerates live canvas ids).
const canvasDirs = vi.hoisted(() => ({
  refresh: vi.fn(),
  list: vi.fn<() => Array<{ id: string; filename: string }>>(() => []),
}));

vi.mock('../storage/canvas-dirs.js', () => ({
  refreshCanvasDirIndex: canvasDirs.refresh,
  listAllCanvasDirEntries: () => canvasDirs.list(),
}));

const canvasStore = vi.hoisted(() => ({
  read: vi.fn(() => ({ state: { nodes: [] } })),
}));

vi.mock('../storage/index.js', () => ({
  getCanvasStore: () => canvasStore,
}));

/** Build a fresh fake FSWatcher whose `.on(...)` chain is a no-op. */
function makeFakeWatcher() {
  const w = {
    on: vi.fn(() => w),
    close: vi.fn(async () => undefined),
  };
  return w;
}

function makeFakeNativeWatcher() {
  const nativeWatcher = {
    on: vi.fn(() => nativeWatcher),
    close: vi.fn(),
  };
  return nativeWatcher;
}

function emitWatcherEvent(event: string, ...args: unknown[]): unknown {
  const calls = current.on.mock.calls as unknown as Array<
    [string, (...callbackArgs: unknown[]) => unknown]
  >;
  const callback = calls.find(([registered]) => registered === event)?.[1];
  if (!callback) throw new Error(`No watcher handler registered for ${event}`);
  return callback(...args);
}

function emitNativeWatcherEvent(filename: string): void {
  const callback = nativeWatchMock.mock.calls.at(-1)?.[2] as
    | ((eventType: string, changedFilename: string) => void)
    | undefined;
  if (!callback) throw new Error('No native watcher callback registered');
  callback('rename', filename);
}

import {
  openExternalNoteSession,
  resetExternalNoteWatcher,
  runWithExternalNoteWatcherSuspended,
} from './external-watcher.js';

import type { ExternalNoteEvent } from '@sediment/shared';

/** Markdown reads issued so far — `space.json` topology reads excluded. */
function markdownReads(): string[] {
  return fileIO.readFile.mock.calls
    .map(([filePath]) => filePath)
    .filter((filePath) => filePath.endsWith('.md'));
}

let current: ReturnType<typeof makeFakeWatcher>;
let currentNative: ReturnType<typeof makeFakeNativeWatcher>;

beforeEach(() => {
  watchMock.mockReset();
  current = makeFakeWatcher();
  watchMock.mockImplementation(() => {
    current = makeFakeWatcher();
    return current;
  });
  nativeWatchMock.mockReset();
  currentNative = makeFakeNativeWatcher();
  nativeWatchMock.mockImplementation(() => {
    currentNative = makeFakeNativeWatcher();
    return currentNative;
  });
  fileIO.readFile.mockReset();
  fileIO.readFile.mockImplementation(async (filePath: string) =>
    filePath.endsWith('space.json')
      ? JSON.stringify({ state: { nodes: [] } })
      : '---\nid: external-note\n---\n',
  );
  fileIO.readdir.mockReset();
  fileIO.readdir.mockResolvedValue([]);
  fileIO.stat.mockClear();
  canvasStore.read.mockClear();
  canvasDirs.list.mockReturnValue([]);
  state.configured = true;
});

afterEach(async () => {
  // Tear the module-level watcher down so state does not leak between tests.
  state.configured = false;
  await resetExternalNoteWatcher();
});

describe('workspace lifecycle watcher', () => {
  it('arms only a depth-zero Chokidar watcher at startup', async () => {
    canvasDirs.list.mockReturnValue([
      { id: 'canvas-a', filename: 'canvas-a' },
      { id: 'canvas-b', filename: 'canvas-b' },
    ]);
    await resetExternalNoteWatcher();

    expect(watchMock).toHaveBeenCalledWith(
      '/ws',
      expect.objectContaining({ ignoreInitial: true, depth: 0 }),
    );
    // Inactive Spaces own no watcher and are never enumerated at startup.
    expect(nativeWatchMock).not.toHaveBeenCalled();
    expect(fileIO.readdir).not.toHaveBeenCalled();
    expect(markdownReads()).toHaveLength(0);
  });

  it('invalidates only for top-level directory changes after initial scan', async () => {
    await resetExternalNoteWatcher();
    canvasDirs.refresh.mockClear();

    emitWatcherEvent('addDir', '/ws/canvas-a');
    expect(canvasDirs.refresh).not.toHaveBeenCalled();

    emitWatcherEvent('ready');
    emitWatcherEvent('addDir', '/ws/canvas-a');
    emitWatcherEvent('addDir', '/ws/canvas-a/nodes');
    emitWatcherEvent('unlinkDir', '/ws/canvas-b');

    expect(canvasDirs.refresh).toHaveBeenCalledTimes(2);
  });

  it('re-arms an active Space watcher at its new directory after a rename', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'old-name' }]);
    await resetExternalNoteWatcher();
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const beforeRename = currentNative;
    nativeWatchMock.mockClear();

    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'new-name' }]);
    emitWatcherEvent('ready');
    emitWatcherEvent('addDir', '/ws/new-name');

    expect(beforeRename.close).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/new-name[\\/]nodes$/);
    session.close();
  });

  it('empties an active session whose Space was deleted', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    const watcherBefore = currentNative;
    nativeWatchMock.mockClear();

    canvasDirs.list.mockReturnValue([]);
    emitWatcherEvent('ready');
    emitWatcherEvent('unlinkDir', '/ws/canvas-a');

    expect(watcherBefore.close).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'snapshot', data: { items: [] } });
    session.close();
  });
});

describe('openExternalNoteSession', () => {
  it('watches only the Space that has a subscriber', async () => {
    canvasDirs.list.mockReturnValue([
      { id: 'canvas-a', filename: 'canvas-a' },
      { id: 'canvas-b', filename: 'canvas-b' },
    ]);
    await resetExternalNoteWatcher();

    const session = await openExternalNoteSession('canvas-a', vi.fn());

    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/canvas-a[\\/]nodes$/);
    session.close();
  });

  it('registers the native watcher before enumerating the directory', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const order: string[] = [];
    nativeWatchMock.mockImplementation(() => {
      order.push('watch');
      currentNative = makeFakeNativeWatcher();
      return currentNative;
    });
    fileIO.readdir.mockImplementation(async () => {
      order.push('readdir');
      return [];
    });
    await resetExternalNoteWatcher();

    const session = await openExternalNoteSession('canvas-a', vi.fn());

    expect(order).toEqual(['watch', 'readdir']);
    session.close();
  });

  it('shares one watcher and one scan across concurrent subscribers', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
    ]);
    await resetExternalNoteWatcher();

    const [first, second] = await Promise.all([
      openExternalNoteSession('canvas-a', vi.fn()),
      openExternalNoteSession('canvas-a', vi.fn()),
    ]);

    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    expect(markdownReads()).toHaveLength(1);
    expect(first.snapshot).toEqual(second.snapshot);

    const shared = currentNative;
    first.close();
    first.close(); // idempotent
    expect(shared.close).not.toHaveBeenCalled();

    second.close();
    expect(shared.close).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent note reads during a lazy Space scan', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue(
      Array.from({ length: 9 }, (_, index) => ({
        name: `note-${index}.md`,
        isFile: () => true,
      })),
    );
    const releaseReads: Array<() => void> = [];
    fileIO.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('space.json')) {
        return JSON.stringify({ state: { nodes: [] } });
      }
      return new Promise<string>((resolve) => {
        releaseReads.push(() => resolve('---\nid: external-note\n---\n'));
      });
    });
    await resetExternalNoteWatcher();

    const opening = openExternalNoteSession('canvas-a', vi.fn());

    await vi.waitFor(() => {
      expect(markdownReads()).toHaveLength(8);
    });

    releaseReads.splice(0, 8).forEach((release) => release());
    await vi.waitFor(() => {
      expect(markdownReads()).toHaveLength(9);
    });
    releaseReads.splice(0).forEach((release) => release());
    (await opening).close();
  });

  it('reads the Space topology at most once per lazy scan', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
      { name: 'second.md', isFile: () => true },
    ]);
    await resetExternalNoteWatcher();

    const first = await openExternalNoteSession('canvas-a', vi.fn());
    const second = await openExternalNoteSession('canvas-a', vi.fn());

    const readPaths = fileIO.readFile.mock.calls.map(([filePath]) => filePath);
    expect(
      readPaths.filter((filePath) => filePath.endsWith('.md')),
    ).toHaveLength(2);
    expect(
      readPaths.filter((filePath) => filePath.endsWith('space.json')),
    ).toHaveLength(1);
    expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    expect(first.snapshot).toHaveLength(2);

    first.close();
    second.close();
  });

  it('retries a failed initial scan on a later subscription', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockRejectedValueOnce(new Error('EBUSY'));
    await resetExternalNoteWatcher();

    const failed = await openExternalNoteSession('canvas-a', vi.fn());
    expect(failed.snapshot).toEqual([]);

    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
    ]);
    const retried = await openExternalNoteSession('canvas-a', vi.fn());

    expect(fileIO.readdir).toHaveBeenCalledTimes(2);
    expect(retried.snapshot).toHaveLength(1);

    failed.close();
    retried.close();
  });

  it('delivers no events to a released subscriber while the session lives on', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
    ]);
    await resetExternalNoteWatcher();

    const listener = vi.fn();
    const holder = await openExternalNoteSession('canvas-a', vi.fn());
    const session = await openExternalNoteSession('canvas-a', listener);
    session.close();

    emitNativeWatcherEvent('later.md');
    await vi.waitFor(() => {
      expect(canvasStore.read).toHaveBeenCalled();
    });
    expect(listener).not.toHaveBeenCalled();

    holder.close();
  });
});

describe('native note events', () => {
  it('emits one added event per file and never invalidates the dir index', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    canvasDirs.refresh.mockClear();

    emitNativeWatcherEvent('later.md');
    emitNativeWatcherEvent('later.md');

    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events[0]).toMatchObject({
      type: 'added',
      data: { relativePath: 'nodes/later.md' },
    });

    // A repeat observation replaces the entry instead of duplicating it.
    emitNativeWatcherEvent('later.md');
    await vi.waitFor(() => {
      expect(canvasStore.read.mock.calls.length).toBeGreaterThan(1);
    });
    expect(events).toHaveLength(1);
    expect(canvasDirs.refresh).not.toHaveBeenCalled();

    session.close();
  });

  it('stops delivering events after the final subscriber closes', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();
    const listener = vi.fn();
    const session = await openExternalNoteSession('canvas-a', listener);

    emitNativeWatcherEvent('later.md');
    session.close();

    await vi.waitFor(() => {
      expect(currentNative.close).toHaveBeenCalledTimes(1);
    });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('runWithExternalNoteWatcherSuspended', () => {
  it('is a no-op passthrough when no watcher is running', async () => {
    // No workspace configured → `resetExternalNoteWatcher` arms nothing.
    state.configured = false;
    await resetExternalNoteWatcher();
    watchMock.mockClear();

    const fn = vi.fn(async () => 'result');
    const out = await runWithExternalNoteWatcherSuspended(fn);

    expect(out).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
    // Must NOT spin up a watcher that was intentionally absent.
    expect(watchMock).not.toHaveBeenCalled();
  });

  it('closes the active watcher for the duration of fn and re-arms after', async () => {
    await resetExternalNoteWatcher(); // arms watcher #1
    const first = current;
    expect(watchMock).toHaveBeenCalledTimes(1);

    let closedDuringFn = false;
    const out = await runWithExternalNoteWatcherSuspended(async () => {
      closedDuringFn = first.close.mock.calls.length > 0;
      return 42;
    });

    expect(out).toBe(42);
    expect(closedDuringFn).toBe(true);
    expect(first.close).toHaveBeenCalledTimes(1);
    // Re-armed: a second watcher was built after fn resolved.
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it('re-arms the watcher even when fn throws', async () => {
    await resetExternalNoteWatcher(); // arms watcher #1
    const first = current;

    await expect(
      runWithExternalNoteWatcherSuspended(async () => {
        throw new Error('rename failed');
      }),
    ).rejects.toThrow('rename failed');

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledTimes(2); // re-armed despite the throw
  });

  it('shares a single close/re-arm cycle across nested suspensions', async () => {
    await resetExternalNoteWatcher(); // arms watcher #1
    const first = current;
    watchMock.mockClear();

    await runWithExternalNoteWatcherSuspended(async () => {
      await runWithExternalNoteWatcherSuspended(async () => {
        // Inner suspension: watcher already closed by the outer bracket,
        // so it must NOT close/re-arm again.
        expect(first.close).toHaveBeenCalledTimes(1);
        expect(watchMock).not.toHaveBeenCalled();
      });
      // Still inside the outer bracket: no re-arm yet.
      expect(watchMock).not.toHaveBeenCalled();
    });

    // Outer bracket exited → exactly one close and one re-arm for the pair.
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it('re-arms only the watchers of Spaces that still have subscribers', async () => {
    // Guards the active-session boundary: suspension must release every live
    // handle (so Windows can rename/delete the directory) and then re-arm
    // exactly the active Spaces — never the inactive ones.
    canvasDirs.list.mockReturnValue([
      { id: 'canvas-a', filename: 'canvas-a' },
      { id: 'canvas-b', filename: 'canvas-b' },
    ]);
    await resetExternalNoteWatcher();
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const before = currentNative;
    nativeWatchMock.mockClear();
    canvasDirs.refresh.mockClear();

    await runWithExternalNoteWatcherSuspended(async () => {
      expect(before.close).toHaveBeenCalledTimes(1);
      expect(nativeWatchMock).not.toHaveBeenCalled();
    });

    expect(canvasDirs.refresh).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/canvas-a[\\/]nodes$/);
    session.close();
  });

  it('empties an active session whose Space was deleted while suspended', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    nativeWatchMock.mockClear();

    await runWithExternalNoteWatcherSuspended(async () => {
      canvasDirs.list.mockReturnValue([]);
    });

    expect(nativeWatchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'snapshot', data: { items: [] } });
    session.close();
  });
});
