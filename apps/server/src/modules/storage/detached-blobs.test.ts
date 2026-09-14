// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Where a Space's bytes go when its records are rows.
 *
 * The portable behaviour — put, read, sweep on delete — is already proven for
 * every profile by `product-boundary.test.ts`, and naming a directory there
 * would stop it being evidence of anything portable. What is left is the part
 * that *is* about placement, and it belongs here: bytes are files on every
 * profile, so a backend with no Space folder still needs one, and it has to be
 * scoped to the Workspace that owns the Space and removed with it.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  diskBlobRoot,
  diskDataDir,
  diskSpaceBlobRoot,
  workspaceRegistryPath,
} from './backends/disk/data-dir.js';
import { ARTIFACTS_DIR_NAME } from './backends/disk/layout.js';
import {
  activateWorkspace,
  createNamedWorkspace,
  createSpace,
  deleteSpace,
  space,
} from './storage.js';
import { mountTestWorkspace, type MountedTestStorage } from './testing.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { StorageProfile } from './profile.js';

/** Records in SQLite, bytes on the file system — the hybrid this covers. */
const HYBRID: StorageProfile = {
  structured: { kind: 'sqlite' },
  blobs: { kind: 'disk' },
};

const CANVAS_ID = 'canvas-detached-blobs';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

async function mount(): Promise<MountedTestStorage> {
  mounted = await mountTestWorkspace(HYBRID, 'huabu-detached-blobs-');
  return mounted;
}

/** The directory this profile puts one Space's artifacts in. */
function artifactsDirectory(canvasId: string): string {
  const workspace = getWorkspaceHandle();
  if (!workspace) throw new Error('Expected an active Workspace');
  return path.join(
    diskSpaceBlobRoot(workspace.workspaceId, canvasId),
    ARTIFACTS_DIR_NAME,
  );
}

function isInside(parent: string, child: string): boolean {
  return path.resolve(child).startsWith(`${path.resolve(parent)}${path.sep}`);
}

describe('Space bytes on a backend with no Space folder', () => {
  it('writes real files under the Workspace-scoped byte root', async () => {
    await mount();
    await createSpace(CANVAS_ID, 'Detached');

    await space(CANVAS_ID).artifacts.put('art.bin', Buffer.from('real bytes'));

    const file = path.join(artifactsDirectory(CANVAS_ID), 'art.bin');
    expect(readFileSync(file)).toEqual(Buffer.from('real bytes'));
  });

  it("files each Workspace's bytes under its own root", async () => {
    await mount();
    const firstWorkspace = getWorkspaceHandle();
    if (!firstWorkspace) throw new Error('Expected an active Workspace');
    await createSpace(CANVAS_ID, 'First');
    await space(CANVAS_ID).artifacts.put('art.bin', Buffer.from('first'));
    const first = artifactsDirectory(CANVAS_ID);

    const second = await createNamedWorkspace('Second Workspace');
    await activateWorkspace(second);
    const otherCanvasId = 'canvas-detached-blobs-second';
    await createSpace(otherCanvasId, 'Second');
    await space(otherCanvasId).artifacts.put('art.bin', Buffer.from('second'));

    // Two Workspaces served by one connection and one blob root, and neither
    // can reach into the other's bytes: the Workspace segment is what keeps
    // them apart, the same way a Workspace folder does on Disk.
    const secondDirectory = artifactsDirectory(otherCanvasId);
    expect(path.dirname(path.dirname(first))).not.toBe(
      path.dirname(path.dirname(secondDirectory)),
    );
    expect(readFileSync(path.join(first, 'art.bin'))).toEqual(
      Buffer.from('first'),
    );

    await activateWorkspace(firstWorkspace);
    expect(await space(CANVAS_ID).artifacts.read('art.bin')).toEqual(
      Buffer.from('first'),
    );
  });

  it('is not a Space tree, so no Disk-only capability turns on', async () => {
    await mount();
    await createSpace(CANVAS_ID, 'Detached');
    await space(CANVAS_ID).artifacts.put('art.bin', Buffer.from('bytes'));

    // The byte directory exists and holds real files, and the Space still has
    // no `diskTree`. That single `null` is what every Disk-only feature keys
    // on — bundle export, reveal-in-file-manager, the built-in file tools,
    // RFS, external-note claim — so it is the fact worth pinning: a file
    // system for bytes is not a Space directory and grants none of them.
    expect(existsSync(artifactsDirectory(CANVAS_ID))).toBe(true);
    expect(space(CANVAS_ID).diskTree).toBeNull();
  });

  it('leaves no directory behind when the Space is deleted', async () => {
    await mount();
    await createSpace(CANVAS_ID, 'Detached');
    await space(CANVAS_ID).artifacts.put('art.bin', Buffer.from('bytes'));
    const spaceRoot = path.dirname(artifactsDirectory(CANVAS_ID));
    expect(existsSync(spaceRoot)).toBe(true);

    await expect(deleteSpace(CANVAS_ID)).resolves.toMatchObject({ ok: true });

    // Sweeping the areas is the blob port's contract; removing the directory
    // composition put them under is this module's, and nothing else would.
    expect(existsSync(spaceRoot)).toBe(false);
  });
});

/**
 * The two Disk adapters share `storage/disk/`, so the line between them is a
 * path fact and is tested as one.
 *
 * They are never both in use — the registry belongs to the Disk *structured*
 * store and the byte roots appear only when some other backend holds the
 * records — but one data directory can see both across a backend switch. The
 * blob store deletes whole directories; the registry is not its to delete.
 */
describe('the Disk backend area in the data directory', () => {
  const DATA_DIR = '/var/lib/huabu';

  it('gives the registry and the byte roots separate subtrees', () => {
    const registry = workspaceRegistryPath(DATA_DIR);
    const blobs = diskBlobRoot(DATA_DIR);

    expect(isInside(diskDataDir(DATA_DIR), registry)).toBe(true);
    expect(isInside(diskDataDir(DATA_DIR), blobs)).toBe(true);
    // The one that matters: no sweep of a Space's bytes, an area, or the whole
    // blob root can reach the structured store's registry.
    expect(isInside(blobs, registry)).toBe(false);
    expect(isInside(blobs, diskSpaceBlobRoot('ws', 'canvas', DATA_DIR))).toBe(
      true,
    );
  });

  it('moves only the bytes when HUABU_BLOB_ROOT is set', () => {
    const previous = process.env['HUABU_BLOB_ROOT'];
    process.env['HUABU_BLOB_ROOT'] = '/mnt/bulk/huabu-bytes';
    try {
      expect(diskSpaceBlobRoot('ws', 'canvas', DATA_DIR)).toBe(
        path.join('/mnt/bulk/huabu-bytes', 'ws', 'canvas'),
      );
      // The registry is the structured store's and does not follow.
      expect(workspaceRegistryPath(DATA_DIR)).toBe(
        path.join(diskDataDir(DATA_DIR), 'workspaces.json'),
      );
    } finally {
      if (previous === undefined) delete process.env['HUABU_BLOB_ROOT'];
      else process.env['HUABU_BLOB_ROOT'] = previous;
    }
  });
});
