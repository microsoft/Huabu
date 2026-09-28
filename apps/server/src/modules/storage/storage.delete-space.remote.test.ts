// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * What is left of a Space after it is deleted, on every selectable pairing.
 *
 * Deletion is the one operation that spans both axes and has no second chance:
 * the structured record is what names the Space, so once it is gone nothing
 * will ever come looking for the bytes again. Whatever survives survives
 * forever, silently, and is paid for monthly on an object store.
 *
 * Composition owns two thirds of the sweep — the port deletes the areas, and
 * this module removes the directory it put those areas under — and that second
 * part is conditional on where the bytes went. So the claim is made for every
 * pairing at once, in the same case: no bytes anywhere, no husk anywhere, and
 * the Space next to it untouched.
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { BlobServiceClient } from '@azure/storage-blob';
import { afterEach, describe, expect, it } from 'vitest';

import { diskSpaceBlobRoot } from './backends/disk/data-dir.js';
import {
  SPACE_GUIDE_SKILL_NAME,
  SPACE_MEMORY_BLOB_NAME,
} from './ports/blob.js';
import { createSpace, deleteSpace, space } from './storage.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from './testing.js';
import { getWorkspaceHandle } from '../workspace.js';

import type { StorageProfile } from './profile.js';

const DOOMED = 'space-delete-sweep';
const NEIGHBOUR = 'space-delete-neighbour';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.close();
  mounted = null;
});

/** One blob in each area a Space owns, so no area can be swept by omission. */
async function fillEveryArea(canvasId: string, body: string): Promise<void> {
  const handle = space(canvasId);
  await handle.artifacts.put('art.bin', Buffer.from(`artifact ${body}`));
  await handle.uploads.put('staged.bin', Buffer.from(`upload ${body}`));
  await handle.memory.put(SPACE_MEMORY_BLOB_NAME, Buffer.from(`# ${body}`));
  await handle.guide.put(SPACE_GUIDE_SKILL_NAME, Buffer.from(`# ${body}`));
}

/**
 * Every object this Space still owns in the container.
 *
 * Listed from the account rather than through the adapter: an adapter that
 * believes it deleted something is the failure being looked for. Matching on
 * the Space segment rather than rebuilding the key keeps this from agreeing
 * with the adapter's escaping by construction.
 */
async function remainingBlobs(canvasId: string): Promise<string[]> {
  const connection = process.env['HUABU_AZURE_STORAGE_CONNECTION_STRING'];
  const container = process.env['HUABU_AZURE_BLOB_CONTAINER'];
  if (!connection || !container) return [];
  const client =
    BlobServiceClient.fromConnectionString(connection).getContainerClient(
      container,
    );
  const found: string[] = [];
  for await (const blob of client.listBlobsFlat({
    includeUncommitedBlobs: true,
  })) {
    if (blob.name.includes(`/${canvasId}/`)) found.push(blob.name);
  }
  return found;
}

/** Anything under `root` still named after the Space, at any depth. */
function remainingPaths(root: string, canvasId: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === canvasId) found.push(full);
      if (entry.isDirectory()) walk(full);
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

/**
 * The one directory this profile puts a Space's local state in.
 *
 * Where the records are files that is the Space's own directory, bytes
 * included when they are local. Where they are rows it is the byte root
 * composition hands the Disk blob adapter — and when the bytes are remote
 * there should be no such directory at any point, which is worth asserting
 * rather than assuming.
 */
function localHome(profile: StorageProfile, canvasId: string): string {
  if (profile.structured.kind === 'disk') {
    const directory = space(canvasId).diskTree?.existingDirectory();
    if (!directory) throw new Error('Expected a Disk Space directory');
    return directory;
  }
  const workspace = getWorkspaceHandle();
  if (!workspace) throw new Error('Expected an active Workspace');
  return diskSpaceBlobRoot(workspace.workspaceId, canvasId);
}

forEachProductProfile((profile: StorageProfile, label: string) => {
  describe(`deleting a Space (${label})`, () => {
    it('leaves no bytes, no husk, and the Space beside it intact', async () => {
      mounted = await mountTestWorkspace(profile, 'huabu-delete-sweep-');
      expect((await createSpace(DOOMED, 'Doomed')).ok).toBe(true);
      expect((await createSpace(NEIGHBOUR, 'Neighbour')).ok).toBe(true);
      await fillEveryArea(DOOMED, 'doomed');
      await fillEveryArea(NEIGHBOUR, 'neighbour');

      const home = localHome(profile, DOOMED);
      const localBytes = profile.blobs.kind === 'disk';
      // A profile has a local directory for a Space when its records are files
      // or its bytes are, and neither when a database holds one and an object
      // store holds the other.
      const localHomeExists = profile.structured.kind === 'disk' || localBytes;
      // Precondition, so the sweep cannot pass by having written nothing: the
      // bytes really are where this profile says they go, and nowhere else.
      expect(existsSync(home)).toBe(localHomeExists);
      expect((await remainingBlobs(DOOMED)).length).toBe(localBytes ? 0 : 4);

      await expect(deleteSpace(DOOMED)).resolves.toMatchObject({ ok: true });

      expect(await space(DOOMED).read()).toBeNull();
      expect(await remainingBlobs(DOOMED)).toEqual([]);
      // Nothing local survives either — neither the Space's own directory nor
      // the byte root composition placed its areas under. The second one is
      // skipped when the bytes are remote, on the grounds that it was never
      // created; this is where that reasoning is checked rather than trusted.
      expect(existsSync(home)).toBe(false);
      expect(remainingPaths(mounted.workspacePath, DOOMED)).toEqual([]);

      // A sweep by prefix is one mistaken boundary away from taking the
      // neighbours with it, and the structured record would still be there to
      // make the loss look like corruption rather than deletion.
      expect(await space(NEIGHBOUR).artifacts.read('art.bin')).toEqual(
        Buffer.from('artifact neighbour'),
      );
      expect(await space(NEIGHBOUR).guide.read(SPACE_GUIDE_SKILL_NAME)).toEqual(
        Buffer.from('# neighbour'),
      );
      expect((await remainingBlobs(NEIGHBOUR)).length).toBe(localBytes ? 0 : 4);
      expect(existsSync(localHome(profile, NEIGHBOUR))).toBe(localHomeExists);
    });
  });
});
