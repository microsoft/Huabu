/**
 * @file Tests for `runWithExternalNoteWatcherSuspended` — the depth-counted
 * bracket that fully closes the single workspace chokidar watcher for the
 * duration of a server-owned canvas rename/delete (so a live `fs.watch`
 * handle cannot block `renameSync` / `rmSync` with EPERM on Windows) and
 * then re-arms it.
 *
 * chokidar and the workspace resolver are mocked so the module can be
 * exercised without a real filesystem: `chokidar.watch` returns a fake
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
  ensureExternalNotesScanned,
  resetExternalNoteWatcher,
  runWithExternalNoteWatcherSuspended,
} from './external-watcher.js';

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

describe('canvas directory index invalidation', () => {
  it('uses depth-zero Chokidar and native node-directory watchers', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();

    expect(watchMock).toHaveBeenCalledWith(
      '/ws',
      expect.objectContaining({ ignoreInitial: true, depth: 0 }),
    );
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/canvas-a[\\/]nodes$/);
  });

  it('bounds concurrent note reads during a lazy canvas scan', async () => {
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

    const scan = ensureExternalNotesScanned('canvas-a');

    await vi.waitFor(() => {
      expect(
        fileIO.readFile.mock.calls.filter(([filePath]) =>
          filePath.endsWith('.md'),
        ),
      ).toHaveLength(8);
    });

    releaseReads.splice(0, 8).forEach((release) => release());
    await vi.waitFor(() => {
      expect(
        fileIO.readFile.mock.calls.filter(([filePath]) =>
          filePath.endsWith('.md'),
        ),
      ).toHaveLength(9);
    });
    releaseReads.splice(0).forEach((release) => release());
    await scan;
  });

  it('reads each canvas topology once during its lazy scan', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
      { name: 'second.md', isFile: () => true },
    ]);
    await resetExternalNoteWatcher();

    await ensureExternalNotesScanned('canvas-a');
    await ensureExternalNotesScanned('canvas-a');

    const readPaths = fileIO.readFile.mock.calls.map(([filePath]) => filePath);
    expect(
      readPaths.filter((filePath) => filePath.endsWith('.md')),
    ).toHaveLength(2);
    expect(
      readPaths.filter((filePath) => filePath.endsWith('space.json')),
    ).toHaveLength(1);
    expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    expect(canvasStore.read).not.toHaveBeenCalled();

    emitNativeWatcherEvent('later.md');

    await vi.waitFor(() => {
      expect(canvasStore.read).toHaveBeenCalledTimes(1);
    });
  });

  it('does not invalidate the directory index for native note events', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    await resetExternalNoteWatcher();
    canvasDirs.refresh.mockClear();

    emitNativeWatcherEvent('later.md');

    await vi.waitFor(() => {
      expect(canvasStore.read).toHaveBeenCalledTimes(1);
    });

    expect(canvasDirs.refresh).not.toHaveBeenCalled();
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

  it('refreshes the dir index and enumerates live canvases before re-arming', async () => {
    // Guards the delete-cleanup prune: a canvas whose subtree is removed
    // while suspended emits no `unlink`, so on re-arm the bracket must
    // refresh the index and query the surviving ids to drop stale pending
    // state. (pendingByCanvas is module-private, so we assert the prune
    // step runs rather than its effect on a seeded entry.)
    await resetExternalNoteWatcher(); // arms watcher #1
    canvasDirs.refresh.mockClear();
    canvasDirs.list.mockClear();

    await runWithExternalNoteWatcherSuspended(async () => undefined);

    expect(canvasDirs.refresh).toHaveBeenCalledTimes(1);
    // Once for stale-pending pruning and once to rebuild native node watchers.
    expect(canvasDirs.list).toHaveBeenCalledTimes(2);
  });
});
