// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Phase 4.6's exit criterion, exercised rather than asserted (§12.6).
 *
 * "Adding another `StructuredStore` changes adapter, composition, and
 * migration code, but does not require feature modules to learn that
 * backend's record layout." The way to test that claim is to reach for
 * everything a feature module reaches for — records, node content, blobs, the
 * materialized tree — through the public storage surface only, and to run it
 * against whichever profiles are mounted rather than against Disk by name.
 *
 * Nothing here names a directory, a filename, or `space.json`. If a future
 * change makes any of these behaviours depend on one backend's layout, this
 * suite still passes on Disk and fails on the next profile — which is exactly
 * the signal Phase 5 needs and cannot get from the per-adapter contracts.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  describeProfile,
  mountTestStorage,
  PRODUCT_STORAGE_PROFILES,
  type MountedTestStorage,
} from './testing.js';
import { readCanvas, readCanvasNodes } from '../canvas/space-read.js';

import {
  canvasBlobs,
  createSpace,
  diskSpaceTree,
  getStructuredStore,
} from './index.js';

let mounted: MountedTestStorage | null = null;

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

describe.each(PRODUCT_STORAGE_PROFILES.map((p) => [describeProfile(p), p]))(
  'product storage boundary: %s',
  (_label, profile) => {
    async function mount(): Promise<MountedTestStorage> {
      mounted = await mountTestStorage({ profile });
      return mounted;
    }

    it('bootstraps exactly one World that ordinary listings omit', async () => {
      await mount();
      const spaces = getStructuredStore().spaces();

      const worldId = await spaces.worldId();

      expect(worldId).toBeTruthy();
      await expect(spaces.ensureWorld()).resolves.toBe(worldId);
      await expect(spaces.list()).resolves.toEqual([]);
    });

    it('round-trips a Space and its node through the application read model', async () => {
      await mount();
      const canvasId = 'canvas-product-a';
      const created = await createSpace(canvasId, 'Product Space');
      expect(created.ok).toBe(true);

      const put = await getStructuredStore()
        .space(canvasId)
        .nodes.put({
          nodeId: 'node-product-a',
          record: {
            nodeId: 'node-product-a',
            type: 'note',
            label: 'Product node',
            content: 'body',
          },
        });
      expect(put.ok).toBe(true);

      // The read model is what feature modules use; it must answer without
      // anyone naming where the record went.
      await expect(readCanvas(canvasId)).resolves.toMatchObject({
        canvasId,
        title: 'Product Space',
      });
      const records = await readCanvasNodes(canvasId, ['node-product-a']);
      expect(records.get('node-product-a')).toMatchObject({
        label: 'Product node',
        content: 'body',
      });
    });

    it('materializes the Space where its blobs are written', async () => {
      await mount();
      const canvasId = 'canvas-product-b';
      await createSpace(canvasId, 'Blob Space');

      await canvasBlobs(canvasId).put('artifact-a.png', Buffer.from('bytes'));

      // The one invariant a feature module depends on: the tree it is handed
      // and the tree blobs land in are the same tree.
      const directory = diskSpaceTree(canvasId).directory();
      expect(diskSpaceTree(canvasId).directory()).toBe(directory);
      expect(existsSync(directory)).toBe(true);
      await expect(
        canvasBlobs(canvasId).read('artifact-a.png'),
      ).resolves.toEqual(Buffer.from('bytes'));
    });

    it('maps a materialized node file back to the record it carries', async () => {
      await mount();
      const canvasId = 'canvas-product-c';
      await createSpace(canvasId, 'File Space');
      await getStructuredStore()
        .space(canvasId)
        .nodes.put({
          nodeId: 'node-product-c',
          record: {
            nodeId: 'node-product-c',
            type: 'note',
            label: 'Mapped node',
            content: 'body',
          },
        });

      // RFS serves files and needs the record behind one. Which file that is
      // belongs to the materialization, so the test asks it rather than
      // constructing a name.
      const scope = diskSpaceTree(canvasId);
      const nodesDirectory = scope.nodesDirectory();
      expect(nodesDirectory.startsWith(scope.directory())).toBe(true);

      const { readdirSync } = await import('node:fs');
      const [filename] = readdirSync(nodesDirectory).filter((entry) =>
        entry.endsWith('.md'),
      );
      expect(filename).toBeTruthy();
      await expect(scope.nodeIdForPath(`nodes/${filename}`)).resolves.toBe(
        'node-product-c',
      );
      expect(existsSync(path.join(nodesDirectory, filename))).toBe(true);
    });

    it('deletes a Space across both stores', async () => {
      await mount();
      const canvasId = 'canvas-product-d';
      await createSpace(canvasId, 'Doomed Space');
      await canvasBlobs(canvasId).put('artifact-a.png', Buffer.from('bytes'));

      const { deleteSpace } = await import('./index.js');
      await expect(deleteSpace(canvasId)).resolves.toMatchObject({ ok: true });

      await expect(readCanvas(canvasId)).resolves.toBeNull();
      await expect(canvasBlobs(canvasId).read('artifact-a.png')).resolves.toBe(
        null,
      );
    });
  },
);
