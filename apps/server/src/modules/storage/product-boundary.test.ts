// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Phase 4.6's exit criterion, run against a real backend.
 *
 * The criterion: adding another `StructuredStore` changes adapter,
 * composition, and migration code, but does not require Canvas, agent, web,
 * RFS, interactive-view, Task, or Workspace feature modules to learn that
 * backend's record layout (proposal §12.6).
 *
 * A suite cannot assert that about code it does not run, so this asserts the
 * observable half: every durable thing the product does with a Space, driven
 * through the portable surface, against a profile mounted the way a Server
 * mounts one. **It names no directory, no filename, and no `space.json`** —
 * `module-boundaries.test.ts` enforces that mechanically, because the moment a
 * case reaches for a path it stops being evidence of anything portable.
 *
 * Phase 5 adds SQLite to `PRODUCT_STORAGE_PROFILES` and every case below runs
 * against it unchanged. A case that then fails is a real gap in the adapter;
 * a case that needs editing to pass is a leak in this suite.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

import {
  SPACE_GUIDE_SKILL_NAME,
  SPACE_MEMORY_BLOB_NAME,
} from './ports/blob.js';
import { deleteSpace } from './storage.js';
import {
  forEachProductProfile,
  mountTestWorkspace,
  type MountedTestStorage,
} from './testing.js';

import type { StorageProfile } from './profile.js';
import type { CanvasFile } from '../canvas/persistence-types.js';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

const NODE_A = 'node-product-a';
const NODE_B = 'node-product-b';

function record(canvasId: string, version: number): CanvasFile {
  return {
    canvasId,
    title: 'Product Space',
    version,
    state: {
      nodes: [
        { id: NODE_A, type: 'note', position: { x: 0, y: 0 }, data: {} },
        { id: NODE_B, type: 'note', position: { x: 10, y: 0 }, data: {} },
      ],
      edges: [],
    },
    createdAt: 1,
    updatedAt: 2,
  } as CanvasFile;
}

function note(nodeId: string, content: string) {
  return { nodeId, type: 'note', label: nodeId, content };
}

/**
 * A real change record, built through the engine rather than hand-rolled.
 *
 * `coalesceChanges` groups by the forward delta it reconstructs from
 * `revertDeltas`, so a fabricated record with none is silently dropped and
 * the case would assert nothing.
 */
function change(nodeId: string) {
  const [built] = extractCanvasChanges([
    {
      type: 'INSERT_NODE',
      node: {
        id: nodeId,
        type: 'note',
        position: { x: 0, y: 0 },
        data: { label: nodeId, content: 'body' },
      } as CanvasNode,
    },
  ]);
  return built;
}

forEachProductProfile((profile: StorageProfile, label: string) => {
  describe(`product storage boundary (${label})`, () => {
    let mounted: MountedTestStorage | null = null;

    async function open(): Promise<MountedTestStorage> {
      mounted = await mountTestWorkspace(profile, `huabu-product-${label}-`);
      return mounted;
    }

    /** A Space with two nodes, created the way the product creates one. */
    async function seedSpace(canvasId: string): Promise<MountedTestStorage> {
      const m = await open();
      const created = await m.storage.structured
        .spaces()
        .create({ canvasId, title: 'Product Space' });
      if (!created.ok) throw new Error('Expected to create the Space');

      const write = await m.storage.space(canvasId).write({
        expectedVersion: 0,
        nextRecord: {
          ...record(canvasId, 1),
          title: created.record.title,
          createdAt: created.record.createdAt,
        },
        nodeMutations: [
          { kind: 'put', nodeId: NODE_A, record: note(NODE_A, 'alpha') },
          { kind: 'put', nodeId: NODE_B, record: note(NODE_B, 'beta') },
        ],
      });
      expect(write).toEqual({ ok: true });
      return m;
    }

    afterEach(async () => {
      await mounted?.close();
      mounted = null;
    });

    it('bootstraps a World that ordinary listings exclude', async () => {
      const m = await open();
      const spaces = m.storage.structured.spaces();

      // The mount already ensured it — a Workspace with no World has no
      // Portal target, so this is not something the product does later.
      const worldId = await spaces.worldId();
      expect(worldId).toEqual(expect.any(String));
      await expect(spaces.list()).resolves.toEqual([]);
      await expect(spaces.ensureWorld()).resolves.toBe(worldId);
    });

    it('creates a Space and reads back the record it was promised', async () => {
      const m = await open();
      const spaces = m.storage.structured.spaces();
      const created = await spaces.create({
        canvasId: 'space-product-create',
        title: 'Product Space',
      });
      if (!created.ok) throw new Error('Expected to create the Space');

      expect(created.record).toMatchObject({
        canvasId: 'space-product-create',
        version: 0,
        state: { nodes: [], edges: [] },
      });
      await expect(
        m.storage.space('space-product-create').read(),
      ).resolves.toEqual(created.record);
      expect((await spaces.list()).map((row) => row.canvasId)).toEqual([
        'space-product-create',
      ]);
    });

    it('serves one ordered write through every node read shape', async () => {
      const canvasId = 'space-product-nodes';
      const m = await seedSpace(canvasId);
      const nodes = m.storage.space(canvasId).nodes;

      await expect(m.storage.space(canvasId).read()).resolves.toMatchObject({
        version: 1,
      });

      const single = await nodes.read(NODE_A);
      expect(single?.record.content).toBe('alpha');

      const listed = await nodes.list();
      expect([...listed.keys()].sort()).toEqual([NODE_A, NODE_B].sort());
      expect(listed.get(NODE_A)).toEqual(single);

      const selection = await nodes.readMany([NODE_B]);
      expect([...selection.keys()]).toEqual([NODE_B]);

      const delivered: string[] = [];
      const streamed = await nodes.stream((snapshot) =>
        delivered.push(snapshot.record.nodeId),
      );
      expect(streamed).toEqual(listed);
      expect(delivered.sort()).toEqual([NODE_A, NODE_B].sort());
    });

    it('refuses a write from a version the caller no longer holds', async () => {
      const canvasId = 'space-product-cas';
      const m = await seedSpace(canvasId);

      await expect(
        m.storage.space(canvasId).write({
          expectedVersion: 0,
          nextRecord: record(canvasId, 1),
          nodeMutations: [],
        }),
      ).resolves.toEqual({
        ok: false,
        reason: 'version-conflict',
        actualVersion: 1,
      });
    });

    it('keeps bytes for every area of a Space and tells them apart', async () => {
      const canvasId = 'space-product-blobs';
      const m = await seedSpace(canvasId);
      const handle = m.storage.space(canvasId);

      await handle.artifacts.put('artifact.bin', Buffer.from('artifact bytes'));
      await handle.memory.put(SPACE_MEMORY_BLOB_NAME, Buffer.from('# memory'));
      await handle.guide.put(SPACE_GUIDE_SKILL_NAME, Buffer.from('# guide'));
      await handle.uploads.put('staged.bin', Buffer.from('staged bytes'));

      expect(await handle.artifacts.read('artifact.bin')).toEqual(
        Buffer.from('artifact bytes'),
      );
      expect(await handle.memory.read(SPACE_MEMORY_BLOB_NAME)).toEqual(
        Buffer.from('# memory'),
      );
      // Areas are separate namespaces, so one area's name is not another's.
      expect(await handle.artifacts.read(SPACE_MEMORY_BLOB_NAME)).toBeNull();
      expect((await handle.uploads.list()).map((info) => info.name)).toEqual([
        'staged.bin',
      ]);
    });

    it('refuses bytes for a Space that does not exist', async () => {
      const m = await open();

      // The one cross-store rule: bytes only for a Space whose record exists.
      await expect(
        m.storage
          .space('space-product-absent')
          .artifacts.put('orphan.bin', Buffer.from('x')),
      ).rejects.toThrow();
    });

    it('gives a namespace an isolated place and destroys it with the Space', async () => {
      const canvasId = 'space-product-extension';
      const m = await seedSpace(canvasId);

      const substrate = await m.storage
        .space(canvasId)
        .extension('product.owner');
      expect(substrate?.kind).toBe(profile.structured.kind);

      // A Space that is gone has no substrate, which is what keeps an owner
      // from resurrecting one by writing its own bookkeeping.
      await deleteSpace(canvasId);
      await expect(
        m.storage.space(canvasId).extension('product.owner'),
      ).resolves.toBeNull();
    });

    it('appends and reads the Space log families', async () => {
      const canvasId = 'space-product-logs';
      const m = await seedSpace(canvasId);
      const handle = m.storage.space(canvasId);

      await handle.events.append([
        {
          payload: {
            action: 'node_created',
            nodes: [{ id: NODE_A, type: 'note' }],
          },
          ts: 10,
        },
      ]);
      const events = await handle.events.read();
      expect(events).toHaveLength(1);

      const appended = await handle.changes.append('thread-product', [
        change(NODE_A),
      ]);
      expect(appended).toHaveLength(1);
      const changeId = appended[0].id;
      await expect(handle.changes.read('thread-product')).resolves.toHaveLength(
        1,
      );
      await expect(
        handle.changes.delete('thread-product', changeId),
      ).resolves.toMatchObject({ id: changeId });
      await expect(handle.changes.read('thread-product')).resolves.toEqual([]);
    });

    it('keeps a Task and its Runs in one ledger', async () => {
      const canvasId = 'space-product-tasks';
      const m = await seedSpace(canvasId);
      const tasks = m.storage.space(canvasId).tasks;

      await tasks.create({
        taskId: 'task-1',
        canvasId,
        goal: 'Do the thing',
        defaultRootProfileId: 'profile-1',
        anchorNodeId: NODE_A,
        createdAt: 1,
      });
      await tasks.runs.create({
        runId: 'run-1',
        taskId: 'task-1',
        canvasIdSnapshot: canvasId,
        goalSnapshot: 'Do the thing',
        rootProfileIdSnapshot: 'profile-1',
        status: 'pending',
        createdAt: 2,
      });

      const snapshot = await tasks.read();
      expect(snapshot.tasks.map((task) => task.taskId)).toEqual(['task-1']);
      expect(snapshot.runs.map((run) => run.runId)).toEqual(['run-1']);

      await tasks.runs.update('run-1', { status: 'running', startedAt: 3 });
      const completed = await tasks.runs.complete('task-1', 'run-1', {
        completedAt: 4,
        message: 'done',
      });
      expect(completed.outcome).toBe('completed');
    });

    it('removes a Space and everything it held', async () => {
      const canvasId = 'space-product-delete';
      const m = await seedSpace(canvasId);
      const handle = m.storage.space(canvasId);
      await handle.artifacts.put('artifact.bin', Buffer.from('bytes'));
      await handle.memory.put(SPACE_MEMORY_BLOB_NAME, Buffer.from('# memory'));

      await expect(deleteSpace(canvasId)).resolves.toEqual({
        ok: true,
        reason: 'deleted',
      });

      const after = m.storage.space(canvasId);
      await expect(after.read()).resolves.toBeNull();
      await expect(after.nodes.list()).resolves.toEqual(new Map());
      // Every area, not only artifacts: an unswept one is an orphan on a
      // backend where dropping the record does not remove the area.
      expect(await after.artifacts.read('artifact.bin')).toBeNull();
      expect(await after.memory.read(SPACE_MEMORY_BLOB_NAME)).toBeNull();
      await expect(m.storage.structured.spaces().list()).resolves.toEqual([]);
    });

    it('refuses to delete the World', async () => {
      const m = await open();
      const spaces = m.storage.structured.spaces();
      const worldId = await spaces.worldId();

      await expect(deleteSpace(worldId)).resolves.toEqual({
        ok: false,
        reason: 'world-forbidden',
      });
      await expect(spaces.worldId()).resolves.toBe(worldId);
    });
  });
});
