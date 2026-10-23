// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invertDelta } from '@huabu/shared/canvas-engine';

import { applyDeltasOnServer, executeOnServer } from './canvas-executor.js';
import * as canvasSync from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import {
  createChildSpace,
  deleteSpaceTree,
  deletionPreview,
  setSpaceParent,
} from './space-hierarchy.js';
import { registerSpaceHierarchyRoutes } from './space-hierarchy.route.js';
import { moveCanvasSelection } from './space-move.service.js';
import { assertChildSpaceEntriesAllowed } from './world-preview-policy.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
import * as storage from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasNodeId } from '@huabu/shared';
import type { CanvasNode } from '@huabu/shared/canvas-engine';

let workspace: string;
beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'huabu-hierarchy-'));
  setWorkspacePath(workspace);
  storage.resetStorageCache();
  await storage.createSpace('root', 'Root');
});
afterEach(() => {
  vi.restoreAllMocks();
  storage.resetStorageCache();
  rmSync(workspace, { recursive: true, force: true });
});
const list = () => storage.getStructuredStore().spaces().list();

describe('Mixed selection Space migration', () => {
  it('retains the destination and reports uncertainty if ownership compensation fails', async () => {
    const child = await createChildSpace('root', 'Child');
    const source = await storage.space('root').read();
    if (!source || !child.parentEntryNodeId) throw new Error('Missing fixture');
    const repository = storage.getStructuredStore().spaces();
    const original = repository.setParent.bind(repository);
    vi.spyOn(
      Object.getPrototypeOf(repository) as typeof repository,
      'setParent',
    ).mockImplementation(async (input) => {
      if (input.canvasId === child.canvasId && input.parentSpaceId === 'root')
        return false;
      return original(input);
    });
    vi.spyOn(canvasSync, 'publishCanvasUpdate').mockImplementationOnce(() => {
      throw new Error('Publication failed');
    });
    await expect(
      moveCanvasSelection('root', {
        selectedNodeIds: [child.parentEntryNodeId],
        destination: { kind: 'new', title: 'Collection', asChild: true },
        createSourcePreview: false,
        expectedSourceVersion: source.version,
      }),
    ).rejects.toMatchObject({ code: 'MOVE_OUTCOME_UNKNOWN' });
    const destination = (await list()).find(
      (item) => item.title === 'Collection',
    );
    expect(destination).toBeDefined();
    if (!destination) throw new Error('Missing retained destination');
    expect((await storage.space(child.canvasId).read())?.parentSpaceId).toBe(
      destination.canvasId,
    );
    expect(
      (await storage.space(destination.canvasId).read())?.state.nodes,
    ).toHaveLength(1);
  });

  async function fixture() {
    await storage.createSpace('destination', 'Destination');
    const child = await createChildSpace('root', 'Child');
    const grandchild = await createChildSpace(child.canvasId, 'Grandchild');
    if (!child.parentEntryNodeId) throw new Error('Missing child entry');
    const seeded = await executeOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-frame',
              nodeType: 'frame',
              position: { x: 0, y: 0 },
              size: { width: 800, height: 500 },
            },
            {
              id: 'node-note',
              nodeType: 'note',
              position: { x: 30, y: 60 },
              parentId: 'node-frame',
              data: { content: 'Keep this content' },
            },
            {
              id: 'node-shortcut',
              nodeType: 'spacePreview',
              position: { x: 900, y: 0 },
              data: { targetCanvasId: child.canvasId },
            },
          ],
        },
        {
          type: 'SET_NODE_PARENT',
          nodeIds: [child.parentEntryNodeId as CanvasNodeId],
          parentId: 'node-frame',
        },
      ],
    });
    return { child, grandchild, version: seeded.toVersion };
  }

  it.each([false, true])(
    'moves a Frame, owned child, and shortcut together (new child=%s)',
    async (asChild) => {
      const { child, grandchild, version } = await fixture();
      const contents = (await storage.space(child.canvasId).read())?.state;
      const sourceNodes = (await storage.space('root').read())?.state
        .nodes as CanvasNode[];
      const notePosition = sourceNodes.find(
        (node) => node.id === 'node-note',
      )?.position;
      const result = await moveCanvasSelection('root', {
        selectedNodeIds: ['node-frame', 'node-shortcut'],
        destination: asChild
          ? { kind: 'new', title: 'Collection', asChild: true }
          : { kind: 'existing', canvasId: 'destination' },
        createSourcePreview: false,
        expectedSourceVersion: version,
      });
      const destination = await storage
        .space(result.destination.canvasId)
        .read();
      const nodes = destination?.state.nodes as CanvasNode[];
      const frame = nodes.find((node) => node.type === 'frame');
      const entry = nodes.find(
        (node) => node.type === 'spacePreview' && node.parentId === frame?.id,
      );
      expect(entry?.data.targetCanvasId).toBe(child.canvasId);
      expect(nodes.filter((node) => node.type === 'spacePreview')).toHaveLength(
        2,
      );
      expect(await storage.space(child.canvasId).read()).toMatchObject({
        parentSpaceId: result.destination.canvasId,
        parentEntryNodeId: entry?.id,
        state: contents,
      });
      expect(
        (await storage.space(grandchild.canvasId).read())?.parentSpaceId,
      ).toBe(child.canvasId);
      expect(nodes.find((node) => node.type === 'note')).toMatchObject({
        parentId: frame?.id,
        position: notePosition,
      });
      expect((await storage.space('root').read())?.state.nodes).toHaveLength(
        asChild ? 1 : 0,
      );
      if (asChild)
        expect(destination).toMatchObject({
          parentSpaceId: 'root',
          parentEntryNodeId: result.sourcePreviewNodeId,
        });
    },
  );

  it('moves only a shortcut without changing target ownership', async () => {
    const { child, version } = await fixture();
    await moveCanvasSelection('root', {
      selectedNodeIds: ['node-shortcut'],
      destination: { kind: 'existing', canvasId: 'destination' },
      createSourcePreview: false,
      expectedSourceVersion: version,
    });
    expect(await storage.space(child.canvasId).read()).toMatchObject({
      parentSpaceId: 'root',
      parentEntryNodeId: child.parentEntryNodeId,
    });
  });

  it.each(['self', 'descendant'])(
    'rejects owned entries moved into their %s before writes',
    async (target) => {
      const { child, grandchild, version } = await fixture();
      const before = await storage.space('root').read();
      await expect(
        moveCanvasSelection('root', {
          selectedNodeIds: ['node-frame', 'node-shortcut'],
          destination: {
            kind: 'existing',
            canvasId: target === 'self' ? child.canvasId : grandchild.canvasId,
          },
          createSourcePreview: false,
          expectedSourceVersion: version,
        }),
      ).rejects.toMatchObject({ code: 'MOVE_HIERARCHY_CYCLE' });
      expect(await storage.space('root').read()).toEqual(before);
    },
  );

  it.each([false, true])(
    'restores ownership and cards on publication failure (new child=%s)',
    async (asChild) => {
      const { child, version } = await fixture();
      const before = (await storage.space('root').read())?.state;
      vi.spyOn(canvasSync, 'publishCanvasUpdate').mockImplementationOnce(() => {
        throw new Error('Publication failed');
      });
      await expect(
        moveCanvasSelection('root', {
          selectedNodeIds: ['node-frame', 'node-shortcut'],
          destination: asChild
            ? { kind: 'new', title: 'Collection', asChild: true }
            : { kind: 'existing', canvasId: 'destination' },
          createSourcePreview: false,
          expectedSourceVersion: version,
        }),
      ).rejects.toMatchObject({ code: 'MOVE_FAILED' });
      const restored = (await storage.space('root').read())?.state;
      expect(restored?.nodes).toHaveLength(before?.nodes.length ?? 0);
      expect(restored?.nodes).toEqual(
        expect.arrayContaining(before?.nodes ?? []),
      );
      expect(restored?.edges).toEqual(before?.edges);
      expect(await storage.space(child.canvasId).read()).toMatchObject({
        parentSpaceId: 'root',
        parentEntryNodeId: child.parentEntryNodeId,
      });
      expect(
        (await storage.space('destination').read())?.state.nodes,
      ).toHaveLength(0);
      expect((await list()).some((item) => item.title === 'Collection')).toBe(
        false,
      );
    },
  );

  it('restores every attempted parent change when a metadata write fails after committing', async () => {
    await storage.createSpace('destination', 'Destination');
    const first = await createChildSpace('root', 'First');
    const second = await createChildSpace('root', 'Second');
    const source = await storage.space('root').read();
    if (!source || !first.parentEntryNodeId || !second.parentEntryNodeId)
      throw new Error('Missing fixture');
    const repository = storage.getStructuredStore().spaces();
    const original = repository.setParent.bind(repository);
    vi.spyOn(
      Object.getPrototypeOf(repository) as typeof repository,
      'setParent',
    ).mockImplementation(async (input) => {
      const result = await original(input);
      if (
        input.canvasId === second.canvasId &&
        input.parentSpaceId === 'destination'
      )
        throw new Error('After commit');
      return result;
    });
    await expect(
      moveCanvasSelection('root', {
        selectedNodeIds: [first.parentEntryNodeId, second.parentEntryNodeId],
        destination: { kind: 'existing', canvasId: 'destination' },
        createSourcePreview: false,
        expectedSourceVersion: source.version,
      }),
    ).rejects.toMatchObject({ code: 'MOVE_FAILED' });
    for (const child of [first, second]) {
      expect(await storage.space(child.canvasId).read()).toMatchObject({
        parentSpaceId: 'root',
        parentEntryNodeId: child.parentEntryNodeId,
      });
    }
    expect((await storage.space('root').read())?.state.nodes).toEqual(
      expect.arrayContaining(source.state.nodes),
    );
    expect(
      (await storage.space('destination').read())?.state.nodes,
    ).toHaveLength(0);
  });
});

describe('Space ownership', () => {
  it.each(['success', 'refused', 'failed', 'failed-after-commit'])(
    'publishes the retained entry only after parent persistence settles (%s)',
    async (outcome) => {
      await storage.createSpace('child', 'Child');
      const repository = storage.getStructuredStore().spaces();
      const original = repository.setParent.bind(repository);
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(
        Object.getPrototypeOf(repository) as typeof repository,
        'setParent',
      ).mockImplementationOnce(async (input) => {
        entered();
        await gate;
        if (outcome === 'refused') return false;
        if (outcome === 'failed') throw new Error('Parent write failed');
        const result = await original(input);
        if (outcome === 'failed-after-commit')
          throw new Error('Parent outcome uncertain');
        return result;
      });
      const publish = vi.spyOn(canvasSync, 'publishCanvasUpdate');
      const snapshots: Array<Promise<storage.CanvasFile | null>> = [];
      const unsubscribe = canvasSync.subscribeCanvasUpdates('root', () => {
        snapshots.push(storage.space('child').read());
      });
      const pending = setSpaceParent('child', {
        parentSpaceId: 'root',
        expectedParentSpaceId: null,
      }).then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await waiting;
        expect(publish).not.toHaveBeenCalled();
        expect(
          (await storage.space('child').read())?.parentSpaceId ?? null,
        ).toBeNull();
        release();
        const error = await pending;
        if (outcome === 'success') expect(error).toBeNull();
        else expect(error).toBeInstanceOf(Error);
        expect(publish).toHaveBeenCalledOnce();
        const [snapshot] = await Promise.all(snapshots);
        expect(snapshot?.parentSpaceId ?? null).toBe(
          outcome === 'success' || outcome === 'failed-after-commit'
            ? 'root'
            : null,
        );
        expect((await storage.space('root').read())?.state.nodes).toHaveLength(
          1,
        );
      } finally {
        release();
        await pending;
        unsubscribe();
      }
    },
  );

  it.each(['commands', 'deltas', 'structure', 'sidecar'])(
    'allows malformed dangling shortcut cleanup through %s',
    async (path) => {
      await executeOnServer({
        canvasId: 'root',
        originator: { source: 'ui' },
        commands: [
          {
            type: 'CREATE_NODES',
            nodes: [
              { id: 'node-frame', nodeType: 'frame', position: { x: 0, y: 0 } },
              {
                id: 'node-shortcut',
                nodeType: 'spacePreview',
                parentId: 'node-frame',
                position: { x: 0, y: 0 },
                data: { targetCanvasId: 'invalid/target' },
              },
            ],
          },
        ],
      });
      const app = Fastify();
      await app.register(canvasRoutes);
      try {
        const before = await storage.space('root').read();
        if (!before) throw new Error('Missing fixture');
        if (path === 'commands') {
          await executeOnServer({
            canvasId: 'root',
            originator: { source: 'ui' },
            commands: [{ type: 'DELETE_NODES', nodeIds: ['node-frame'] }],
          });
        } else if (path === 'deltas') {
          await applyDeltasOnServer({
            canvasId: 'root',
            deltas: (before.state.nodes as CanvasNode[]).map((node) => ({
              type: 'DELETE_NODE',
              node,
            })),
            originator: { source: 'ui' },
          });
        } else if (path === 'structure') {
          const response = await app.inject({
            method: 'PUT',
            url: '/root',
            payload: {
              version: before.version,
              state: { nodes: [], edges: [] },
            },
          });
          expect(response.statusCode, response.body).toBe(200);
        } else {
          const response = await app.inject({
            method: 'DELETE',
            url: '/root/nodes/node-shortcut',
          });
          expect(response.statusCode, response.body).toBe(200);
          expect(
            await storage.space('root').nodes.read('node-shortcut'),
          ).toBeNull();
        }
        if (path !== 'sidecar')
          expect((await storage.space('root').read())?.state.nodes).toEqual([]);
      } finally {
        await app.close();
      }
    },
  );

  it.each(['invalid/target', '../target', 'invalid\\target', '', 'bad target'])(
    'does not look up malformed target %j when removing or retargeting a shortcut',
    async (targetCanvasId) => {
      const node = {
        id: 'node-shortcut',
        type: 'spacePreview',
        data: { targetCanvasId },
      };
      const readTarget = vi.spyOn(storage, 'space');
      await assertChildSpaceEntriesAllowed('root', [node], []);
      await assertChildSpaceEntriesAllowed(
        'root',
        [node],
        [{ ...node, data: { targetCanvasId: 'root' } }],
      );
      expect(readTarget).not.toHaveBeenCalled();
    },
  );

  it('accepts geometry-only PUTs but rejects removed or retargeted canonical entries', async () => {
    const child = await createChildSpace('root', 'Child');
    const app = Fastify();
    await app.register(canvasRoutes);
    try {
      const before = await storage.space('root').read();
      if (!before) throw new Error('Missing parent');
      const moved = await app.inject({
        method: 'PUT',
        url: '/root',
        payload: {
          version: before.version,
          state: {
            nodes: [
              { id: child.parentEntryNodeId, position: { x: 20, y: 30 } },
            ],
            edges: [],
          },
        },
      });
      expect(moved.statusCode, moved.body).toBe(200);
      const saved = await storage.space('root').read();
      expect(saved?.state.nodes[0]).toMatchObject({
        type: 'spacePreview',
        data: { targetCanvasId: child.canvasId },
        position: { x: 20, y: 30 },
      });
      for (const nodes of [
        [],
        [
          {
            id: child.parentEntryNodeId,
            position: { x: 20, y: 30 },
            data: { targetCanvasId: 'elsewhere' },
          },
        ],
      ]) {
        const rejected = await app.inject({
          method: 'PUT',
          url: '/root',
          payload: { version: saved?.version, state: { nodes, edges: [] } },
        });
        expect(rejected.statusCode, rejected.body).toBe(409);
      }
    } finally {
      await app.close();
    }
  });

  it('does not list the Workspace or read targets when entry identities are unchanged', async () => {
    const child = await createChildSpace('root', 'Child');
    const before = await storage.space('root').read();
    if (!before) throw new Error('Missing parent');
    const repository = storage.getStructuredStore().spaces();
    const listing = vi
      .spyOn(Object.getPrototypeOf(repository) as typeof repository, 'list')
      .mockRejectedValue(new Error('An unrelated Space is unreadable'));
    const readTarget = vi.spyOn(storage, 'space');
    await assertChildSpaceEntriesAllowed(
      'root',
      before.state.nodes,
      before.state.nodes,
    );
    expect(readTarget).not.toHaveBeenCalled();
    await expect(
      assertChildSpaceEntriesAllowed('root', before.state.nodes, []),
    ).rejects.toThrow('child Space entry');
    expect(readTarget).toHaveBeenCalledWith(child.canvasId);
    expect(listing).not.toHaveBeenCalled();
  });

  it('does not list Workspace membership during ordinary commands, delta replay, or structural saves', async () => {
    const child = await createChildSpace('root', 'Child');
    const repository = storage.getStructuredStore().spaces();
    const listing = vi
      .spyOn(Object.getPrototypeOf(repository) as typeof repository, 'list')
      .mockRejectedValue(new Error('An unrelated Space is unreadable'));
    const created = await executeOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-note',
              nodeType: 'note',
              position: { x: 600, y: 0 },
              data: { content: 'Ordinary edit' },
            },
          ],
        },
      ],
    });
    await applyDeltasOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      deltas: [...created.deltas].reverse().map(invertDelta),
    });
    const current = await storage.space('root').read();
    const app = Fastify();
    await app.register(canvasRoutes);
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/root',
        payload: {
          version: current?.version,
          state: {
            nodes: [
              { id: child.parentEntryNodeId, position: { x: 20, y: 30 } },
            ],
            edges: [],
          },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(listing).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('places the canonical child entry at the requested canvas coordinates', async () => {
    const app = Fastify();
    registerSpaceHierarchyRoutes(app);
    try {
      const position = { x: -145.5, y: 382.25 };
      const response = await app.inject({
        method: 'POST',
        url: '/root/children',
        payload: { title: 'Placed', position },
      });
      expect(response.statusCode).toBe(200);
      const child = response.json();
      expect((await storage.space('root').read())?.state.nodes).toContainEqual(
        expect.objectContaining({
          id: child.parentEntryNodeId,
          position,
          data: expect.objectContaining({ targetCanvasId: child.canvasId }),
        }),
      );
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/root/children',
            payload: { title: 'Invalid', position: { x: '1', y: 0 } },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it('creates arbitrary nesting, retains old links on reparent and rejects cycles', async () => {
    const child = await createChildSpace('root', 'Child');
    const grandchild = await createChildSpace(child.canvasId, 'Grandchild');
    expect(await list()).toContainEqual(expect.objectContaining(child));
    await expect(
      setSpaceParent('root', {
        parentSpaceId: grandchild.canvasId,
        expectedParentSpaceId: null,
      }),
    ).rejects.toMatchObject({ code: 'SPACE_HIERARCHY_CYCLE' });
    await setSpaceParent(child.canvasId, {
      parentSpaceId: null,
      expectedParentSpaceId: 'root',
    });
    expect((await storage.space('root').read())?.state.nodes).toContainEqual(
      expect.objectContaining({ id: child.parentEntryNodeId }),
    );
    expect(
      (await storage.space(child.canvasId).read())?.parentSpaceId,
    ).toBeNull();
  });

  it('serializes opposing reparent requests and rejects missing or World parents', async () => {
    await storage.createSpace('other', 'Other');
    const results = await Promise.allSettled([
      setSpaceParent('root', {
        parentSpaceId: 'other',
        expectedParentSpaceId: null,
      }),
      setSpaceParent('other', {
        parentSpaceId: 'root',
        expectedParentSpaceId: null,
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    await expect(
      setSpaceParent('root', {
        parentSpaceId: 'absent',
        expectedParentSpaceId: 'other',
      }),
    ).rejects.toMatchObject({ code: 'SPACE_PARENT_MISSING' });
    const world = await storage.getStructuredStore().spaces().worldId();
    await expect(createChildSpace(world, 'Forbidden')).rejects.toMatchObject({
      code: 'SPACE_PARENT_MISSING',
    });
  });

  it('protects formal entries but allows deleting a copied shortcut', async () => {
    const child = await createChildSpace('root', 'Child');
    await expect(
      executeOnServer({
        canvasId: 'root',
        originator: { source: 'ui' },
        commands: [
          {
            type: 'DELETE_NODES',
            nodeIds: [child.parentEntryNodeId as `node-${string}`],
          },
        ],
      }),
    ).rejects.toThrow('child Space entry');
    await executeOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-copy',
              nodeType: 'spacePreview',
              data: { targetCanvasId: child.canvasId },
              position: { x: 0, y: 0 },
            },
          ],
        },
      ],
    });
    await executeOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      commands: [{ type: 'DELETE_NODES', nodeIds: ['node-copy'] }],
    });
    expect(await storage.space(child.canvasId).read()).not.toBeNull();
  });

  it('requires renewed confirmation when the subtree changes, then deletes owned descendants only', async () => {
    const child = await createChildSpace('root', 'Child');
    const stale = deletionPreview(await list(), 'root');
    const grandchild = await createChildSpace(child.canvasId, 'Grandchild');
    await storage.createSpace('linked', 'Linked');
    await expect(deleteSpaceTree('root', stale.token)).rejects.toMatchObject({
      code: 'SPACE_TREE_CHANGED',
    });
    await expect(storage.deleteSpace('root')).rejects.toThrow('children');
    const preview = deletionPreview(await list(), 'root');
    expect(await deleteSpaceTree('root', preview.token)).toEqual([
      grandchild.canvasId,
      child.canvasId,
      'root',
    ]);
    expect((await list()).map((item) => item.canvasId)).toEqual(['linked']);
  });

  it('removes the formal entry on child deletion without deleting its parent', async () => {
    const child = await createChildSpace('root', 'Child');
    await deleteSpaceTree(
      child.canvasId,
      deletionPreview(await list(), child.canvasId).token,
    );
    expect((await storage.space('root').read())?.state.nodes).toEqual([]);
  });

  it.each([1, 4, 12])(
    'lists membership once when deleting %i nested Spaces',
    async (count) => {
      const root = await createChildSpace('root', 'Subtree');
      const ids = [root.canvasId];
      for (let index = 1; index < count; index++) {
        const child = await createChildSpace(ids[index - 1], `Child ${index}`);
        ids.push(child.canvasId);
      }
      const preview = deletionPreview(await list(), root.canvasId);
      const repository = storage.getStructuredStore().spaces();
      const listing = vi.spyOn(
        Object.getPrototypeOf(repository) as typeof repository,
        'list',
      );
      expect(await deleteSpaceTree(root.canvasId, preview.token)).toEqual(
        [...ids].reverse(),
      );
      expect(listing).toHaveBeenCalledOnce();
      expect((await storage.space('root').read())?.state.nodes).toEqual([]);
    },
  );

  it('rejects the internal deletion path outside the hierarchy lock', async () => {
    await expect(
      storage.deleteSpaceFromValidatedTreeAlreadyLocked('root'),
    ).rejects.toThrow('hierarchy lock');
    expect(await storage.space('root').read()).not.toBeNull();
  });

  it('reports completed and remaining members after a partial deletion failure', async () => {
    const child = await createChildSpace('root', 'Child');
    const original = storage.deleteSpaceFromValidatedTreeAlreadyLocked;
    vi.spyOn(
      storage,
      'deleteSpaceFromValidatedTreeAlreadyLocked',
    ).mockImplementation(async (id) => {
      if (id === 'root') throw new Error('Storage unavailable');
      return original(id);
    });
    await expect(
      deleteSpaceTree('root', deletionPreview(await list(), 'root').token),
    ).rejects.toMatchObject({
      code: 'SPACE_TREE_DELETE_FAILED',
      details: {
        deletedCanvasIds: [child.canvasId],
        remainingCanvasIds: ['root'],
      },
    });
    expect(await storage.space('root').read()).not.toBeNull();
  });

  it('stops before deleting ancestors when a descendant is refused', async () => {
    const child = await createChildSpace('root', 'Child');
    const deletion = vi
      .spyOn(storage, 'deleteSpaceFromValidatedTreeAlreadyLocked')
      .mockResolvedValue({
        ok: false,
        reason: 'world-forbidden',
      });
    await expect(
      deleteSpaceTree('root', deletionPreview(await list(), 'root').token),
    ).rejects.toMatchObject({
      code: 'SPACE_TREE_DELETE_FAILED',
      details: {
        deletedCanvasIds: [],
        remainingCanvasIds: [child.canvasId, 'root'],
      },
    });
    expect(deletion).toHaveBeenCalledExactlyOnceWith(child.canvasId);
    expect(await list()).toHaveLength(2);
  });
  it('rejects a busy conversation before deleting any subtree member', async () => {
    const child = await createChildSpace('root', 'Child');
    await executeOnServer({
      canvasId: child.canvasId,
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-agent',
              nodeType: 'question',
              position: { x: 0, y: 0 },
              data: {
                threadId: 'thread-busy',
                agentBinding: { kind: 'internal' },
                content: 'Draft',
              },
            },
          ],
        },
      ],
    });
    const release = acquireAgentTurn('thread-busy')!;
    try {
      await expect(
        deleteSpaceTree('root', deletionPreview(await list(), 'root').token),
      ).rejects.toMatchObject({ code: 'SPACE_AGENT_RUNNING' });
      expect(await list()).toHaveLength(2);
    } finally {
      release();
    }
  });

  it('collects a selection into a child using the existing move transaction', async () => {
    const initial = await executeOnServer({
      canvasId: 'root',
      originator: { source: 'ui' },
      commands: [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-note',
              nodeType: 'note',
              position: { x: 0, y: 0 },
              data: { content: 'Keep me' },
            },
          ],
        },
      ],
    });
    const result = await moveCanvasSelection('root', {
      selectedNodeIds: ['node-note'],
      destination: { kind: 'new', title: 'Collected', asChild: true },
      createSourcePreview: false,
      expectedSourceVersion: initial.toVersion,
    });
    expect(
      await storage.space(result.destination.canvasId).read(),
    ).toMatchObject({
      parentSpaceId: 'root',
      parentEntryNodeId: result.sourcePreviewNodeId,
    });
    expect(result.sourcePreviewNodeId).toBeTruthy();
  });

  it('validates hierarchy HTTP inputs and returns explicit confirmation conflicts', async () => {
    const app = Fastify();
    registerSpaceHierarchyRoutes(app);
    try {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/root/children',
            payload: { title: '' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'PATCH',
            url: '/root/parent',
            payload: {
              parentSpaceId: '../elsewhere',
              expectedParentSpaceId: null,
            },
          })
        ).statusCode,
      ).toBe(400);
      const created = await app.inject({
        method: 'POST',
        url: '/root/children',
        payload: { title: 'API Child' },
      });
      expect(created.statusCode).toBe(200);
      const preview = await app.inject('/root/deletion-preview');
      expect(preview.json().spaces).toHaveLength(2);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/root/delete-tree',
            payload: { token: 'stale' },
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/root/delete-tree',
            payload: { token: preview.json().token },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
