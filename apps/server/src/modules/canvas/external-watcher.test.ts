// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * @file Tests for external-note discovery: the per-active-Space native
 * `nodes/` watcher owned by an external-note SSE session, its lazy scan, and
 * its registration with the Space-directory handle registry (so a
 * server-owned rename/delete can release the handle that would otherwise
 * fail `renameSync` / `rmSync` with EPERM on Windows).
 *
 * `node:fs`, `node:fs/promises`, and the workspace resolver are mocked so the
 * module can be exercised without a real filesystem.
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
  stat: vi.fn<
    (filePath: string) => Promise<{
      mtimeMs: number;
      dev?: number;
      ino?: number;
      birthtimeMs?: number;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }>
  >(async () => ({
    mtimeMs: 1,
    isFile: () => true,
    isDirectory: () => false,
  })),
}));

vi.mock('node:fs/promises', () => fileIO);

const nativeWatchMock = vi.hoisted(() => vi.fn());
const nativeStatSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', () => ({
  watch: nativeWatchMock,
  statSync: nativeStatSyncMock,
}));

vi.mock('../workspace.js', () => ({
  isWorkspaceConfigured: () => state.configured,
  getWorkspacePath: () => '/ws',
}));

vi.mock('../../utils/logger.js', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

const canvasDirs = vi.hoisted(() => ({
  list: vi.fn<() => Array<{ id: string; filename: string }>>(() => []),
}));

vi.mock('../storage/canvas-dirs.js', () => ({
  listAllCanvasDirEntries: () => canvasDirs.list(),
}));

const spaceHandle = vi.hoisted(() => ({
  read: vi.fn(async () => ({ state: { nodes: [] } })),
}));

// The facade is stubbed for the Space handle, but the directory-handle
// helpers must stay the real ones: these cases drive
// `withSpaceDirHandlesReleased` and assert the watcher released its handles,
// which only works if both sides share the one module instance that holds the
// registry.
vi.mock('../storage/index.js', async () => {
  const handles = await import('../storage/backends/disk/space-dir-handles.js');
  return {
    space: () => spaceHandle,
    registerSpaceDirHandleOwner: handles.registerSpaceDirHandleOwner,
    withSpaceDirHandlesReleased: handles.withSpaceDirHandlesReleased,
  };
});

function makeFakeNativeWatcher() {
  const nativeWatcher = {
    on: vi.fn(() => nativeWatcher),
    close: vi.fn(),
  };
  return nativeWatcher;
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
  resetExternalNoteSessions,
} from './external-watcher.js';
import { withSpaceDirHandlesReleased } from '../storage/index.js';

import type { ExternalNoteEvent } from '@huabu/shared';

/** Markdown reads issued so far — `space.json` topology reads excluded. */
function markdownReads(): string[] {
  return fileIO.readFile.mock.calls
    .map(([filePath]) => filePath)
    .filter((filePath) => filePath.endsWith('.md'));
}

let currentNative: ReturnType<typeof makeFakeNativeWatcher>;

beforeEach(() => {
  nativeWatchMock.mockReset();
  nativeStatSyncMock.mockReset();
  nativeStatSyncMock.mockReturnValue({
    dev: 1,
    ino: 1,
    birthtimeMs: 1,
    isDirectory: () => true,
  });
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
  fileIO.stat.mockReset();
  fileIO.stat.mockResolvedValue({
    mtimeMs: 1,
    isFile: () => true,
    isDirectory: () => false,
  });
  spaceHandle.read.mockClear();
  canvasDirs.list.mockReturnValue([]);
  state.configured = true;
});

afterEach(() => {
  // Drop module-level sessions so state does not leak between tests.
  state.configured = false;
  resetExternalNoteSessions();
});

describe('openExternalNoteSession', () => {
  it('registers no watcher until a Space is subscribed', async () => {
    canvasDirs.list.mockReturnValue([
      { id: 'canvas-a', filename: 'canvas-a' },
      { id: 'canvas-b', filename: 'canvas-b' },
    ]);

    // Nothing observes the workspace on its own — inactive Spaces are never
    // enumerated and hold no handle.
    expect(nativeWatchMock).not.toHaveBeenCalled();
    expect(fileIO.readdir).not.toHaveBeenCalled();

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

    const session = await openExternalNoteSession('canvas-a', vi.fn());

    expect(order).toEqual(['watch', 'readdir']);
    session.close();
  });

  it('shares one watcher and one scan across concurrent subscribers', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
    ]);

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

    const first = await openExternalNoteSession('canvas-a', vi.fn());
    const afterFirst = spaceHandle.read.mock.calls.length;
    const second = await openExternalNoteSession('canvas-a', vi.fn());

    const readPaths = fileIO.readFile.mock.calls.map(([filePath]) => filePath);
    expect(
      readPaths.filter((filePath) => filePath.endsWith('.md')),
    ).toHaveLength(2);
    // Topology comes from the Space record now, not a file beside `nodes/`,
    // so the invariant is counted on the port: the second subscriber shares
    // the first's scan and pays only for its own snapshot.
    expect(spaceHandle.read.mock.calls.length - afterFirst).toBe(1);
    expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    expect(first.snapshot).toHaveLength(2);

    first.close();
    second.close();
  });

  it('retries a failed initial scan on a later subscription', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockRejectedValueOnce(new Error('EBUSY'));

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

  it('watches the Space root until a missing nodes directory appears', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    let nodesExists = false;
    nativeWatchMock.mockImplementation(
      (watchPath: string, _options: unknown, _callback: unknown) => {
        if (
          watchPath.split('\\').join('/').endsWith('/nodes') &&
          !nodesExists
        ) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        currentNative = makeFakeNativeWatcher();
        return currentNative;
      },
    );
    fileIO.stat.mockImplementation(async (filePath: string) => {
      if (filePath.split('\\').join('/').endsWith('/nodes')) {
        if (!nodesExists) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        return {
          mtimeMs: 1,
          isFile: () => false,
          isDirectory: () => true,
        };
      }
      return {
        mtimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
      };
    });

    const listener = vi.fn();
    const first = await openExternalNoteSession('canvas-a', listener);
    const second = await openExternalNoteSession('canvas-a', vi.fn());

    expect(first.snapshot).toEqual([]);
    expect(second.snapshot).toEqual([]);
    expect(nativeWatchMock).toHaveBeenCalledTimes(2);
    expect(
      String(nativeWatchMock.mock.calls[0]?.[0]).split('\\').join('/'),
    ).toMatch(/canvas-a[/]nodes$/);
    expect(nativeWatchMock.mock.calls[1]?.[0]).toMatch(/canvas-a$/);
    // The second subscriber shares the parent watcher instead of issuing a
    // second failing readdir/watch against the missing child directory.
    expect(fileIO.readdir).not.toHaveBeenCalled();

    nodesExists = true;
    const parentCallback = nativeWatchMock.mock.calls[1]?.[2] as
      | ((eventType: string, filename: string) => void)
      | undefined;
    parentCallback?.('rename', 'nodes');

    await vi.waitFor(() => {
      expect(nativeWatchMock).toHaveBeenCalledTimes(3);
      expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    });
    expect(
      String(nativeWatchMock.mock.calls[2]?.[0]).split('\\').join('/'),
    ).toMatch(/canvas-a[/]nodes$/);

    // The promoted child watcher remains live and reports later sidecars.
    emitNativeWatcherEvent('later.md');
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'added',
          data: expect.objectContaining({ relativePath: 'nodes/later.md' }),
        }),
      );
    });

    first.close();
    second.close();
  });

  it('probes without holding the Space root open on Windows', async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    let nodesExists = false;
    nativeWatchMock.mockImplementation(
      (watchPath: string, _options: unknown, _callback: unknown) => {
        if (
          watchPath.split('\\').join('/').endsWith('/nodes') &&
          !nodesExists
        ) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        currentNative = makeFakeNativeWatcher();
        return currentNative;
      },
    );
    fileIO.stat.mockImplementation(async (filePath: string) => {
      if (filePath.split('\\').join('/').endsWith('/nodes')) {
        if (!nodesExists) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        return {
          mtimeMs: 1,
          isFile: () => false,
          isDirectory: () => true,
        };
      }
      return {
        mtimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
      };
    });

    let session: Awaited<ReturnType<typeof openExternalNoteSession>> | null =
      null;
    try {
      session = await openExternalNoteSession('canvas-a', vi.fn());

      expect(session.snapshot).toEqual([]);
      expect(nativeWatchMock).toHaveBeenCalledTimes(1);
      expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/canvas-a[\\/]nodes$/);

      nodesExists = true;
      await vi.advanceTimersByTimeAsync(500);

      expect(nativeWatchMock).toHaveBeenCalledTimes(2);
      expect(nativeWatchMock.mock.calls[1]?.[0]).toMatch(/canvas-a[\\/]nodes$/);
      expect(fileIO.readdir).toHaveBeenCalledTimes(1);
    } finally {
      session?.close();
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform,
      });
      vi.useRealTimers();
    }
  });

  it('falls back to the Space root when nodes is deleted, then watches its recreation', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    let nodesExists = true;
    nativeWatchMock.mockImplementation(
      (watchPath: string, _options: unknown, _callback: unknown) => {
        if (
          watchPath.split('\\').join('/').endsWith('/nodes') &&
          !nodesExists
        ) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        currentNative = makeFakeNativeWatcher();
        return currentNative;
      },
    );
    fileIO.stat.mockImplementation(async (filePath: string) => {
      if (filePath.split('\\').join('/').endsWith('/nodes')) {
        if (!nodesExists) {
          throw Object.assign(new Error('missing nodes directory'), {
            code: 'ENOENT',
          });
        }
        return {
          mtimeMs: 1,
          isFile: () => false,
          isDirectory: () => true,
        };
      }
      return {
        mtimeMs: 1,
        isFile: () => true,
        isDirectory: () => false,
      };
    });

    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    const originalChild = currentNative;
    const originalChildCallback = nativeWatchMock.mock.calls[0]?.[2] as
      | ((eventType: string, filename: string) => void)
      | undefined;

    nodesExists = false;
    originalChildCallback?.('rename', 'nodes');

    await vi.waitFor(() => {
      expect(originalChild.close).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toEqual({
        type: 'snapshot',
        data: { items: [] },
      });
      expect(nativeWatchMock).toHaveBeenCalledTimes(3);
    });
    expect(nativeWatchMock.mock.calls[1]?.[0]).toMatch(/canvas-a[\\/]nodes$/);
    expect(nativeWatchMock.mock.calls[2]?.[0]).toMatch(/canvas-a$/);

    nodesExists = true;
    const parentCallback = nativeWatchMock.mock.calls[2]?.[2] as
      | ((eventType: string, filename: string) => void)
      | undefined;
    parentCallback?.('rename', 'nodes');

    await vi.waitFor(
      () => {
        expect(nativeWatchMock).toHaveBeenCalledTimes(4);
        expect(fileIO.readdir).toHaveBeenCalledTimes(2);
      },
      { timeout: 3_000 },
    );
    expect(
      String(nativeWatchMock.mock.calls[3]?.[0]).split('\\').join('/'),
    ).toMatch(/canvas-a[/]nodes$/);

    emitNativeWatcherEvent('after-recreate.md');
    await vi.waitFor(
      () => {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'added',
            data: expect.objectContaining({
              relativePath: 'nodes/after-recreate.md',
            }),
          }),
        );
      },
      { timeout: 3_000 },
    );

    session.close();
  });

  it('delivers no events to a released subscriber while the session lives on', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.readdir.mockResolvedValue([
      { name: 'first.md', isFile: () => true },
    ]);

    const listener = vi.fn();
    const holder = await openExternalNoteSession('canvas-a', vi.fn());
    const session = await openExternalNoteSession('canvas-a', listener);
    session.close();

    emitNativeWatcherEvent('later.md');
    await vi.waitFor(() => {
      expect(spaceHandle.read).toHaveBeenCalled();
    });
    expect(listener).not.toHaveBeenCalled();

    holder.close();
  });
});

describe('native note events', () => {
  it('does not reset the session for an ambiguous event from the same directory', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.stat.mockImplementation(async (filePath: string) =>
      filePath.split('\\').join('/').endsWith('/nodes')
        ? {
            mtimeMs: 1,
            dev: 1,
            ino: 1,
            birthtimeMs: 1,
            isFile: () => false,
            isDirectory: () => true,
          }
        : {
            mtimeMs: 1,
            isFile: () => true,
            isDirectory: () => false,
          },
    );
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    const originalChild = currentNative;
    const callback = nativeWatchMock.mock.calls[0]?.[2] as
      | ((eventType: string, filename: string | null) => void)
      | undefined;

    callback?.('change', null);

    await vi.waitFor(() => {
      expect(fileIO.stat).toHaveBeenCalledWith('/ws/canvas-a/nodes');
    });
    expect(originalChild.close).not.toHaveBeenCalled();
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    session.close();
  });

  it('re-arms when an ambiguous event comes from a replaced directory', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    fileIO.stat.mockResolvedValue({
      mtimeMs: 2,
      dev: 1,
      ino: 2,
      birthtimeMs: 2,
      isFile: () => false,
      isDirectory: () => true,
    });
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    const originalChild = currentNative;
    nativeStatSyncMock.mockReturnValue({
      dev: 1,
      ino: 2,
      birthtimeMs: 2,
      isDirectory: () => true,
    });
    const callback = nativeWatchMock.mock.calls[0]?.[2] as
      | ((eventType: string, filename: string | null) => void)
      | undefined;

    callback?.('rename', null);

    await vi.waitFor(() => {
      expect(originalChild.close).toHaveBeenCalledTimes(1);
      expect(nativeWatchMock).toHaveBeenCalledTimes(2);
    });
    expect(events).toContainEqual({
      type: 'snapshot',
      data: { items: [] },
    });
    session.close();
  });

  it('follows a Space directory renamed outside the server', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'old-name' }]);
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    const originalChild = currentNative;
    fileIO.stat.mockRejectedValue(
      Object.assign(new Error('old Space path is gone'), { code: 'ENOENT' }),
    );
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'new-name' }]);
    const callback = nativeWatchMock.mock.calls[0]?.[2] as
      | ((eventType: string, filename: string | null) => void)
      | undefined;

    callback?.('rename', null);

    await vi.waitFor(() => {
      expect(originalChild.close).toHaveBeenCalledTimes(1);
      expect(nativeWatchMock).toHaveBeenCalledTimes(2);
    });
    expect(nativeWatchMock.mock.calls[1]?.[0]).toMatch(/new-name[\\/]nodes$/);
    expect(events).toContainEqual({
      type: 'snapshot',
      data: { items: [] },
    });
    session.close();
  });

  it('emits one added event per file regardless of duplicate raw events', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );

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
      expect(spaceHandle.read.mock.calls.length).toBeGreaterThan(1);
    });
    expect(events).toHaveLength(1);

    session.close();
  });

  it('stops delivering events after the final subscriber closes', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
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

describe('Space-directory handle release', () => {
  it('does not touch handles for a Space with no subscriber', async () => {
    canvasDirs.list.mockReturnValue([
      { id: 'canvas-a', filename: 'canvas-a' },
      { id: 'canvas-b', filename: 'canvas-b' },
    ]);
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const untouched = currentNative;
    nativeWatchMock.mockClear();

    // Deleting an unopened Space is the common case and must be a plain
    // passthrough — no handle churn anywhere.
    const out = await withSpaceDirHandlesReleased('canvas-b', async () => 'ok');

    expect(out).toBe('ok');
    expect(untouched.close).not.toHaveBeenCalled();
    expect(nativeWatchMock).not.toHaveBeenCalled();
    session.close();
  });

  it('releases and re-acquires the watcher of the mutated Space', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'old-name' }]);
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const before = currentNative;
    nativeWatchMock.mockClear();

    await withSpaceDirHandlesReleased('canvas-a', async () => {
      expect(before.close).toHaveBeenCalledTimes(1);
      expect(nativeWatchMock).not.toHaveBeenCalled();
      // The mutation renames the directory; re-acquire must re-resolve it.
      canvasDirs.list.mockReturnValue([
        { id: 'canvas-a', filename: 'new-name' },
      ]);
    });

    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock.mock.calls[0]?.[0]).toMatch(/new-name[\\/]nodes$/);
    session.close();
  });

  it('re-acquires even when the mutation throws', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const before = currentNative;
    nativeWatchMock.mockClear();

    await expect(
      withSpaceDirHandlesReleased('canvas-a', async () => {
        throw new Error('rename failed');
      }),
    ).rejects.toThrow('rename failed');

    expect(before.close).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('shares one release/re-acquire cycle across nested mutations', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    const before = currentNative;
    nativeWatchMock.mockClear();

    await withSpaceDirHandlesReleased('canvas-a', async () => {
      await withSpaceDirHandlesReleased('canvas-a', async () => {
        expect(before.close).toHaveBeenCalledTimes(1);
        expect(nativeWatchMock).not.toHaveBeenCalled();
      });
      // Still inside the outer bracket: no re-acquire yet.
      expect(nativeWatchMock).not.toHaveBeenCalled();
    });

    expect(before.close).toHaveBeenCalledTimes(1);
    expect(nativeWatchMock).toHaveBeenCalledTimes(1);
    session.close();
  });

  it('empties an active session whose Space was deleted by the mutation', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const events: ExternalNoteEvent[] = [];
    const session = await openExternalNoteSession('canvas-a', (event) =>
      events.push(event),
    );
    nativeWatchMock.mockClear();

    await withSpaceDirHandlesReleased('canvas-a', async () => {
      canvasDirs.list.mockReturnValue([]);
    });

    expect(nativeWatchMock).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ type: 'snapshot', data: { items: [] } });
    session.close();
  });

  it('stops tracking a Space once its last subscriber closed', async () => {
    canvasDirs.list.mockReturnValue([{ id: 'canvas-a', filename: 'canvas-a' }]);
    const session = await openExternalNoteSession('canvas-a', vi.fn());
    session.close();
    nativeWatchMock.mockClear();

    await withSpaceDirHandlesReleased('canvas-a', async () => undefined);

    // Deregistered on close → nothing to release, nothing to re-acquire.
    expect(nativeWatchMock).not.toHaveBeenCalled();
  });
});
