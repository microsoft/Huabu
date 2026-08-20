// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * The Workspace mount lifecycle (proposal §12.6.5).
 *
 * A process serves one Workspace, so the lifecycle is mount, serve, close.
 * What these cases pin is what "mounted" has to mean before anything is
 * served — an opened connection on each axis and a World that exists — and
 * that a mount which cannot reach that state is not published at all. Every
 * case drives a real Disk profile against a temporary root rather than a stub.
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
}));

import { refreshCanvasDirIndex } from './backends/disk/canvas-dirs.js';
import { resetStorageCache } from './backends/disk/legacy/canvas-store-cache.js';
import {
  closeStorage,
  composeStorage,
  createStorage,
  getStorage,
  initStorage,
  mountStorage,
  resetStorage,
  setStorageForTesting,
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

/** Activate `root` the way startup does, before anything is mounted. */
function activate(root: string): void {
  workspaceState.path = root;
  resetStorage();
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
function countingStorage(): {
  storage: ReturnType<typeof composeStorage>;
  closed: () => number;
} {
  let closes = 0;
  const count = async (): Promise<void> => {
    closes += 1;
  };
  const real = createStorage(DISK);
  return {
    storage: composeStorage(
      DISK,
      { ...real.structured, close: count } as unknown as StructuredStore,
      { ...real.blobs, close: count } as unknown as BlobStore,
    ),
    closed: () => closes,
  };
}

afterEach(() => {
  resetStorage();
  workspaceState.path = '';
  resetStorageCache();
  refreshCanvasDirIndex();
});

describe('storage mount lifecycle', () => {
  it('mounts at startup when a Workspace is active', async () => {
    const active = makeWorkspace('huabu-mount-startup-');
    activate(active);

    const mounted = await initStorage(DISK);

    expect(mounted).not.toBeNull();
    expect(getStorage()).toBe(mounted);
    // Startup meets an empty namespace on first run, and the mount is what
    // bootstraps it.
    expect(existsSync(path.join(active, '.world', 'space.json'))).toBe(true);
  });

  it('validates the profile without mounting when no Workspace is active', async () => {
    workspaceState.path = '';

    // Free mode at startup: the profile has to be checkable before anyone has
    // picked a folder, so this opens nothing rather than failing.
    await expect(initStorage(DISK)).resolves.toBeNull();
  });

  it('publishes nothing when the World cannot be bootstrapped', async () => {
    const active = makeWorkspace('huabu-mount-bad-world-');
    // An established World that is malformed is an integrity error, never a
    // signal to mint a replacement identity — so bootstrap refuses.
    seedWorld(active, { canvasId: 'broken' });
    activate(active);

    await expect(mountStorage(DISK)).rejects.toThrow();

    // A half-mounted Workspace is the one outcome this must not produce: the
    // lazy rebuild below is a fresh attempt, not the failed mount published.
    const rebuilt = getStorage();
    await expect(rebuilt.structured.spaces().worldId()).rejects.toThrow();
  });

  it('closes the mount it replaces', async () => {
    const active = makeWorkspace('huabu-mount-replace-');
    seedWorld(active);
    activate(active);
    const previous = countingStorage();
    setStorageForTesting(previous.storage);

    await mountStorage(DISK);

    // Both axes of the replaced mount are released. On Disk `close()` is a
    // no-op, so nothing here would notice a leak — SQLite would.
    expect(previous.closed()).toBe(2);
  });

  it('closes the active mount on shutdown', async () => {
    const active = makeWorkspace('huabu-mount-close-');
    seedWorld(active);
    activate(active);
    const mounted = countingStorage();
    setStorageForTesting(mounted.storage);

    await closeStorage();

    expect(mounted.closed()).toBe(2);
  });

  it('rebuilds after the mount is dropped', async () => {
    const active = makeWorkspace('huabu-mount-reset-');
    seedWorld(active);
    activate(active);
    const mounted = await initStorage(DISK);

    resetStorage();

    // Dropping the mount is what `commitWorkspacePath` does when a test moves
    // between temporary Workspaces. Disk has nothing to open, so the next use
    // rebuilds rather than refusing.
    expect(getStorage()).not.toBe(mounted);
  });
});
