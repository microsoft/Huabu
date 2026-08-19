// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Workspace mount lifecycle (proposal §12.6.5).
 *
 * What these cases are really about is the ordering guarantee: everything that
 * can fail happens while the previous Workspace is still serving, and the swap
 * that makes a new mount reachable cannot fail. That is only observable across
 * two Workspaces, so every case here drives a real Disk profile against two
 * temporary roots rather than a stub.
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceState = vi.hoisted(() => ({ path: '' }));

vi.mock('../workspace.js', () => ({
  getWorkspacePath: () => {
    if (!workspaceState.path) throw new Error('No workspace configured');
    return workspaceState.path;
  },
  isWorkspaceConfigured: () => workspaceState.path !== '',
  acquireWorkspaceOperationLease: () => ({
    workspacePath: workspaceState.path,
    release: () => {},
  }),
}));

import { refreshCanvasDirIndex } from './backends/disk/canvas-dirs.js';
import { resetStorageCache } from './backends/disk/legacy/canvas-store-cache.js';
import {
  closeStorage,
  composeStorage,
  createStorage,
  detachStorage,
  getStorage,
  initStorage,
  setStorageForTesting,
  stageStorage,
} from './storage.js';

import type { BlobStore } from './ports/blob.js';
import type { StructuredStore } from './ports/structured.js';
import type { StorageProfile } from './profile.js';

const DISK: StorageProfile = {
  structured: { kind: 'disk' },
  blobs: { kind: 'disk' },
};

const WORLD_RECORD = {
  canvasId: 'world-existing',
  title: 'World',
  version: 0,
  state: { nodes: [], edges: [] },
  createdAt: 1,
  updatedAt: 1,
};

function makeWorkspace(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Activate `root` the way the synchronous switch does. */
function activate(root: string): void {
  workspaceState.path = root;
  detachStorage();
  resetStorageCache();
  refreshCanvasDirIndex();
}

function seedWorld(root: string, record: unknown = WORLD_RECORD): void {
  const worldRoot = path.join(root, '.world');
  mkdirSync(worldRoot, { recursive: true });
  writeFileSync(
    path.join(worldRoot, 'space.json'),
    JSON.stringify(record),
    'utf8',
  );
}

/** A mount whose connections record whether they were closed. */
function countingStorage(root: string): {
  storage: ReturnType<typeof composeStorage>;
  closed: () => number;
} {
  let closes = 0;
  const count = async (): Promise<void> => {
    closes += 1;
  };
  const real = createStorage(DISK, root);
  return {
    storage: composeStorage(
      DISK,
      root,
      { ...real.structured, close: count } as unknown as StructuredStore,
      { ...real.blobs, close: count } as unknown as BlobStore,
    ),
    closed: () => closes,
  };
}

afterEach(() => {
  detachStorage();
  workspaceState.path = '';
  resetStorageCache();
  refreshCanvasDirIndex();
});

describe('storage mount lifecycle', () => {
  it('bootstraps the Workspace being staged, not the active one', async () => {
    const active = makeWorkspace('huabu-mount-active-');
    seedWorld(active);
    activate(active);
    const target = makeWorkspace('huabu-mount-target-');

    const staged = await stageStorage(target, DISK);

    // The staged Workspace got its World even though it is not active yet —
    // the whole reason the connection is constructed with an explicit path.
    expect(existsSync(path.join(target, '.world', 'space.json'))).toBe(true);
    expect(staged.storage.workspacePath).toBe(target);
    // Nothing about the active Workspace moved.
    expect(getStorage().workspacePath).toBe(active);

    await staged.abort();
  });

  it('leaves the previous mount serving when staging fails', async () => {
    const active = makeWorkspace('huabu-mount-keep-active-');
    seedWorld(active);
    activate(active);
    const before = getStorage();

    // An established World that is malformed is an integrity error, never a
    // signal to mint a replacement identity — so bootstrap refuses.
    const target = makeWorkspace('huabu-mount-bad-world-');
    seedWorld(target, { canvasId: 'broken' });

    await expect(stageStorage(target, DISK)).rejects.toThrow();

    expect(getStorage()).toBe(before);
    expect(getStorage().workspacePath).toBe(active);
    expect(workspaceState.path).toBe(active);
  });

  it('publishes the staged mount and closes the one it replaced', async () => {
    const active = makeWorkspace('huabu-mount-swap-active-');
    seedWorld(active);
    activate(active);
    const previous = countingStorage(active);
    setStorageForTesting(previous.storage);

    const target = makeWorkspace('huabu-mount-swap-target-');
    const staged = await stageStorage(target, DISK);
    expect(previous.closed()).toBe(0);

    // The real sequence: the Workspace path and the mount are published
    // together. Committing the path detaches the mount that no longer
    // describes it, which is exactly the case that used to leave the replaced
    // connections unclosed.
    await staged.commit(() => {
      workspaceState.path = target;
      detachStorage();
    });

    expect(getStorage()).toBe(staged.storage);
    // Both axes of the replaced mount are released.
    expect(previous.closed()).toBe(2);
  });

  it('closes the staged connections on abort and keeps the active mount', async () => {
    const active = makeWorkspace('huabu-mount-abort-active-');
    seedWorld(active);
    activate(active);
    const before = getStorage();

    const target = makeWorkspace('huabu-mount-abort-target-');
    const staged = await stageStorage(target, DISK);
    await staged.abort();

    expect(getStorage()).toBe(before);
  });

  it('closes the active mount on shutdown', async () => {
    const active = makeWorkspace('huabu-mount-close-');
    seedWorld(active);
    activate(active);
    const mounted = countingStorage(active);
    setStorageForTesting(mounted.storage);

    await closeStorage();

    expect(mounted.closed()).toBe(2);
  });

  it('validates the profile without mounting when no Workspace is active', async () => {
    workspaceState.path = '';

    // Free mode at startup: the profile has to be checkable before anyone has
    // picked a folder, so this opens nothing rather than failing.
    await expect(initStorage(DISK)).resolves.toBeNull();
  });

  it('mounts at startup when a Workspace is already active', async () => {
    const active = makeWorkspace('huabu-mount-managed-');
    activate(active);

    const mounted = await initStorage(DISK);

    expect(mounted?.workspacePath).toBe(active);
    // Managed startup meets an empty namespace on first run, and the mount is
    // what bootstraps it.
    expect(existsSync(path.join(active, '.world', 'space.json'))).toBe(true);
  });

  it('drops a mount left behind by a Workspace that moved underneath it', async () => {
    const first = makeWorkspace('huabu-mount-drift-first-');
    seedWorld(first);
    activate(first);
    expect(getStorage().workspacePath).toBe(first);

    // The synchronous switch detaches; this asserts the guard behind it, for
    // any path that changes the active Workspace without one.
    const second = makeWorkspace('huabu-mount-drift-second-');
    seedWorld(second);
    workspaceState.path = second;
    resetStorageCache();
    refreshCanvasDirIndex();

    expect(getStorage().workspacePath).toBe(second);
  });
});
