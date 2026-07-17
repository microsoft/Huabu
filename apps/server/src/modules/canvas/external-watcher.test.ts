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

/** Build a fresh fake FSWatcher whose `.on(...)` chain is a no-op. */
function makeFakeWatcher() {
  const w = {
    on: vi.fn(() => w),
    close: vi.fn(async () => undefined),
  };
  return w;
}

import {
  resetExternalNoteWatcher,
  runWithExternalNoteWatcherSuspended,
} from './external-watcher.js';

let current: ReturnType<typeof makeFakeWatcher>;

beforeEach(() => {
  watchMock.mockReset();
  current = makeFakeWatcher();
  watchMock.mockImplementation(() => {
    current = makeFakeWatcher();
    return current;
  });
  state.configured = true;
});

afterEach(async () => {
  // Tear the module-level watcher down so state does not leak between tests.
  state.configured = false;
  await resetExternalNoteWatcher();
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
});
