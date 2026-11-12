// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Tests for the per-node content endpoint's optimistic-concurrency
 * (compare-and-swap) guard: `PUT /api/canvas/:canvasId/nodes/:nodeId/content`
 * rejects a write whose `expectRev` no longer matches the on-disk node's
 * {@link nodeRevisionOf}, so a concurrent (cross-tab / cross-device /
 * agent, or Google-Drive-synced) write is surfaced as `NODE_CONTENT_CONFLICT`
 * instead of being silently overwritten.
 *
 * Exercised via Fastify `inject()` so the zod body parse, the CAS branch,
 * and the returned `rev` are covered end-to-end. Auth is applied by the
 * global preHandler in `app.ts`, not the route plugin, so injecting the
 * plugin directly needs no Bearer token.
 */

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  nodeRevisionOf,
  extractCanvasChanges,
} from '@huabu/shared/canvas-engine';

import { executeOnServer } from './canvas-executor.js';
import { subscribeCanvasUpdates } from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import {
  getCanvasStore,
  getStorage,
  getStructuredStore,
  setStorageForTesting,
} from '../storage/index.js';
import { nodesDir } from '../storage/paths.js';
import { setWorkspacePath } from '../workspace.js';

import type { BlobScope, BlobStore } from '../storage/index.js';
import type { GetCanvasResponse } from '@huabu/shared';

let tmp: string;

const REV_EMPTY = nodeRevisionOf({});

async function buildApp() {
  const app = fastify();
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

/** Seed topology with a single note node (no `.md` body yet). */
function seedCanvas(canvasId: string, nodeId: string, label: string): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        { id: nodeId, type: 'note', position: { x: 0, y: 0 }, data: { label } },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function putContent(
  app: Awaited<ReturnType<typeof buildApp>>,
  canvasId: string,
  nodeId: string,
  body: Record<string, unknown>,
) {
  return app.inject({
    method: 'PUT',
    url: `/canvas/${canvasId}/nodes/${nodeId}/content`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-cas-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('PUT /nodes/:nodeId/content — content CAS', () => {
  it('rejects existing Note claims over HTTP but initializes a new hidden Note in one batch', async () => {
    seedCanvas('c1', 'node-existing', 'Independent');
    const app = await buildApp();
    try {
      const store = getCanvasStore('c1');
      const independent = store.read()?.state.nodes[0];
      const pdf = {
        id: 'node-pdf',
        type: 'pdf',
        position: { x: 0, y: 0 },
        data: {},
      };
      const claimed = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 1,
          state: {
            nodes: [
              independent,
              { ...pdf, data: { noteNodeId: 'node-existing' } },
            ],
            edges: [],
          },
        },
      });
      expect(claimed.statusCode).toBe(400);
      expect(store.read()?.version).toBe(1);
      const addedPdf = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 1,
          state: { nodes: [independent, pdf], edges: [] },
        },
      });
      expect(addedPdf.statusCode).toBe(200);
      const patch = (id: string) => ({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'node-pdf', patch: { noteNodeId: id } }],
      });
      const rejected = await app.inject({
        method: 'POST',
        url: '/canvas/c1/execute',
        payload: {
          originator: { source: 'agent' },
          commands: [patch('node-existing')],
        },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json().results).toEqual([
        expect.objectContaining({ applied: false, reason: 'invalid-target' }),
      ]);
      const initialized = await app.inject({
        method: 'POST',
        url: '/canvas/c1/execute',
        payload: {
          originator: { source: 'agent' },
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-new',
                  nodeType: 'note',
                  position: { x: 0, y: 0 },
                  data: { content: 'New PDF notes' },
                },
              ],
            },
            patch('node-new'),
          ],
        },
      });
      expect(initialized.statusCode).toBe(200);
      expect(initialized.json().results).toEqual([
        expect.objectContaining({ applied: true }),
        expect.objectContaining({ applied: true }),
      ]);
      expect(store.read()?.state.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'node-new',
            hidden: true,
            selected: false,
          }),
          expect.objectContaining({
            id: 'node-pdf',
            data: expect.objectContaining({ noteNodeId: 'node-new' }),
          }),
        ]),
      );
      expect(store.readNode('node-new')?.content).toBe('New PDF notes');
      expect(store.read()?.state.nodes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'node-existing', hidden: true }),
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it.each([false, true])(
    'reverts a persisted PDF/Note review row atomically (stale: %s)',
    async (stale) => {
      seedCanvas('c1', 'seed', 'Unrelated');
      const app = await buildApp();
      try {
        await executeOnServer({
          canvasId: 'c1',
          originator: { source: 'ui' },
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-pdf',
                  nodeType: 'pdf',
                  position: { x: 0, y: 0 },
                  data: { noteNodeId: 'node-note' },
                },
                {
                  id: 'node-note',
                  nodeType: 'note',
                  position: { x: 0, y: 0 },
                  data: { content: 'Keep my notes' },
                },
              ],
            },
          ],
        });
        const deleted = await executeOnServer({
          canvasId: 'c1',
          originator: { source: 'ui' },
          commands: [{ type: 'DELETE_NODES', nodeIds: ['node-pdf'] }],
        });
        const handle = getStructuredStore().space('c1');
        const [record] = await handle.changes.append(
          'thread-review',
          extractCanvasChanges(deleted.deltas),
        );
        if (stale) {
          await executeOnServer({
            canvasId: 'c1',
            originator: { source: 'ui' },
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: 'node-note',
                    nodeType: 'note',
                    position: { x: 0, y: 0 },
                    data: { content: 'New independent Note' },
                  },
                ],
              },
            ],
          });
        }
        const reverted = await app.inject({
          method: 'POST',
          url: `/canvas/c1/threads/thread-review/changes/${record.id}/revert`,
        });
        expect(reverted.statusCode).toBe(stale ? 409 : 200);
        const nodes = (await handle.read())?.state.nodes;
        if (stale) {
          expect(nodes).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: 'node-pdf' }),
            ]),
          );
          expect(getCanvasStore('c1').readNode('node-note')?.content).toBe(
            'New independent Note',
          );
          expect(await handle.changes.read('thread-review')).toHaveLength(1);
        } else {
          expect(nodes).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: 'node-pdf',
                data: expect.objectContaining({ noteNodeId: 'node-note' }),
              }),
              expect.objectContaining({ id: 'node-note', hidden: true }),
            ]),
          );
          expect(getCanvasStore('c1').readNode('node-note')?.content).toBe(
            'Keep my notes',
          );
          expect(await handle.changes.read('thread-review')).toEqual([]);
        }
      } finally {
        await app.close();
      }
    },
  );

  it('round-trips an owned Note independently and validates structural ownership', async () => {
    seedCanvas('c1', 'pdf', 'Paper');
    const app = await buildApp();
    try {
      const before = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>();
      const nodes = [
        {
          id: 'pdf',
          type: 'pdf',
          position: { x: 0, y: 0 },
          data: { noteNodeId: 'notes' },
        },
        { id: 'notes', type: 'note', position: { x: 0, y: 0 }, data: {} },
      ];
      const linked = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: { version: before.version, state: { nodes, edges: [] } },
      });
      expect(linked.statusCode).toBe(200);
      const saved = await putContent(app, 'c1', 'notes', {
        nodeType: 'note',
        content: 'My independently stored notes',
        label: 'Reading notes',
        expectRev: nodeRevisionOf({}),
      });
      expect(saved.statusCode).toBe(200);
      const loaded = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>();
      expect(loaded.state).toMatchObject({
        nodes: [
          { id: 'pdf', data: { noteNodeId: 'notes' } },
          {
            id: 'notes',
            hidden: true,
            data: { content: 'My independently stored notes' },
          },
        ],
      });
      const invalid = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: loaded.version,
          state: {
            nodes: [{ ...nodes[0], data: { noteNodeId: 'missing' } }, nodes[1]],
            edges: [],
          },
        },
      });
      expect(invalid.statusCode).toBe(400);
      const another = { ...nodes[1], id: 'other-notes' };
      for (const proposed of [
        [{ ...nodes[0], data: { noteNodeId: another.id } }, nodes[1], another],
        [{ ...nodes[0], data: { noteNodeId: another.id } }, another],
        [{ ...nodes[0], data: { noteNodeId: null } }, nodes[1]],
        [nodes[1]],
      ]) {
        const rejected = await app.inject({
          method: 'PUT',
          url: '/canvas/c1',
          payload: {
            version: loaded.version,
            state: { nodes: proposed, edges: [] },
          },
        });
        expect(rejected.statusCode).toBe(400);
      }
      const unlinked = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: loaded.version,
          state: {
            nodes: [{ ...nodes[0], data: { noteNodeId: null } }],
            edges: [],
          },
        },
      });
      expect(unlinked.statusCode).toBe(200);
      const withoutNote = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>();
      expect(withoutNote.state).toMatchObject({
        nodes: [
          {
            id: 'pdf',
            data: expect.not.objectContaining({ noteNodeId: 'notes' }),
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('uses the canonical Office revision even when GET strips a legacy body preamble', async () => {
    seedCanvas('c1', 'office', 'Document');
    const store = getCanvasStore('c1');
    const canvas = store.read();
    if (!canvas) throw new Error('Missing seeded Space');
    canvas.state.nodes = [
      { id: 'office', type: 'office', position: { x: 0, y: 0 }, data: {} },
    ];
    store.write(canvas);
    const content = '---\nparser: officeparser\n---\n\nReadable body';
    store.writeNode('office', {
      nodeId: 'office',
      type: 'office',
      label: 'Document',
      content,
    });
    const app = await buildApp();
    try {
      const read = await app.inject({
        method: 'GET',
        url: '/canvas/c1/nodes/office/content',
      });
      expect(read.json().content).toBe('Readable body');
      const record = store.readNode('office');
      if (!record) throw new Error('Missing Office record');
      expect(read.json().rev).toBe(nodeRevisionOf(record));
      const saved = await putContent(app, 'c1', 'office', {
        nodeType: 'office',
        properties: { Status: 'Read' },
        expectRev: read.json().rev,
      });
      expect(saved.statusCode).toBe(200);
      expect(store.readNode('office')?.content).toBe(content);
    } finally {
      await app.close();
    }
  });

  it('loads the canonical PDF revision without its extracted body and accepts repeated property saves', async () => {
    seedCanvas('c1', 'pdf', 'Paper');
    const store = getCanvasStore('c1');
    const canvas = store.read()!;
    canvas.state.nodes = [
      { id: 'pdf', type: 'pdf', position: { x: 0, y: 0 }, data: {} },
    ];
    store.write(canvas);
    const app = await buildApp();
    try {
      const created = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        label: 'Paper',
        content: 'Extracted PDF text that is not sent to the canvas.',
        properties: { Venue: 'CHI 25' },
        expectRev: REV_EMPTY,
      });
      expect(created.statusCode).toBe(200);
      const loaded = await app.inject({ method: 'GET', url: '/canvas/c1' });
      expect(loaded.statusCode).toBe(200);
      const response = loaded.json<GetCanvasResponse>();
      const state = response.state as {
        nodes: Array<{ data: Record<string, unknown> }>;
      };
      expect(state.nodes[0].data).not.toHaveProperty('content');
      expect(response.nodeContentRevisions?.pdf).toBe(created.json().rev);
      const edited = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        properties: { Status: 'Reading' },
        expectRev: response.nodeContentRevisions?.pdf,
      });
      expect(edited.statusCode).toBe(200);
      const reloaded = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>();
      expect(reloaded.nodeContentRevisions?.pdf).toBe(edited.json().rev);
      const secondEdit = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        properties: { Status: 'Read' },
        expectRev: reloaded.nodeContentRevisions?.pdf,
      });
      expect(secondEdit.statusCode).toBe(200);
      const reordered = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        propertyDisplayKeys: ['Status', 'Venue'],
        expectRev: secondEdit.json().rev,
      });
      expect(reordered.statusCode).toBe(200);
      const afterReorder = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>();
      expect(afterReorder.state).toMatchObject({
        nodes: [
          {
            data: {
              properties: { Venue: 'CHI 25', Status: 'Read' },
              propertyDisplayKeys: ['Status', 'Venue'],
            },
          },
        ],
      });
      expect(afterReorder.nodeContentRevisions?.pdf).toBe(reordered.json().rev);
      const staleEdit = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        properties: { Status: 'Stale' },
        expectRev: response.nodeContentRevisions?.pdf,
      });
      expect(staleEdit.statusCode).toBe(409);
      expect(store.readNode('pdf')?.content).toBe(
        'Extracted PDF text that is not sent to the canvas.',
      );
    } finally {
      await app.close();
    }
  });

  it('round-trips PDF properties with key deletion and CAS', async () => {
    seedCanvas('c1', 'pdf', 'Paper');
    const store = getCanvasStore('c1');
    const canvas = store.read()!;
    canvas.state.nodes = [
      { id: 'pdf', type: 'pdf', position: { x: 0, y: 0 }, data: {} },
    ];
    store.write(canvas);
    const app = await buildApp();
    try {
      const first = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        content: 'extracted',
        expectRev: REV_EMPTY,
        properties: { year: 2026, reviewed: false, authors: ['Ada'] },
        propertyDisplayKeys: ['year'],
      });
      expect(first.statusCode).toBe(200);
      const second = await putContent(app, 'c1', 'pdf', {
        nodeType: 'pdf',
        expectRev: first.json().rev,
        properties: { year: null, reviewed: true },
        propertyDisplayKeys: [],
      });
      expect(second.statusCode).toBe(200);
      const loaded = await app.inject({
        method: 'GET',
        url: '/canvas/c1/nodes/pdf/content',
      });
      expect(loaded.json()).toMatchObject({
        properties: { reviewed: true, authors: ['Ada'] },
        propertyDisplayKeys: [],
        content: 'extracted',
        rev: second.json().rev,
      });
      expect(loaded.json().properties).not.toHaveProperty('year');
      expect(
        (
          await putContent(app, 'c1', 'pdf', {
            nodeType: 'pdf',
            expectRev: first.json().rev,
            properties: { authors: null },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it('notifies the affected node after content save and sidecar deletion, not a rejected CAS', async () => {
    const app = await buildApp();
    const received = vi.fn();
    const unsubscribe = subscribeCanvasUpdates('c1', received);
    try {
      seedCanvas('c1', 'n1', 'Note');
      expect(
        (
          await putContent(app, 'c1', 'n1', {
            nodeType: 'note',
            content: 'first',
            expectRev: REV_EMPTY,
          })
        ).statusCode,
      ).toBe(200);
      expect(received).toHaveBeenCalledExactlyOnceWith({
        type: 'invalidate',
        data: { nodeIds: ['n1'] },
      });
      received.mockClear();
      expect(
        (
          await putContent(app, 'c1', 'n1', {
            nodeType: 'note',
            content: 'stale',
            expectRev: REV_EMPTY,
          })
        ).statusCode,
      ).toBe(409);
      expect(received).not.toHaveBeenCalled();
      expect(
        (await app.inject({ method: 'DELETE', url: '/canvas/c1/nodes/n1' }))
          .statusCode,
      ).toBe(200);
      expect(received).toHaveBeenCalledExactlyOnceWith({
        type: 'invalidate',
        data: { nodeIds: ['n1'] },
      });
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('rejects source/body writes and type spoofing on metadata-only file references', async () => {
    seedCanvas('c1', 'ref', 'Source');
    const store = getCanvasStore('c1');
    const canvas = store.read()!;
    canvas.state.nodes = [
      {
        id: 'ref',
        type: 'fileReference',
        position: { x: 0, y: 0 },
        data: {
          label: 'Source',
          fileReference: {
            agentletId: 'offline-device',
            path: '/private/source.txt',
          },
        },
      },
    ];
    store.write(canvas);
    const app = await buildApp();
    try {
      for (const body of [
        { nodeType: 'fileReference', content: 'secret bytes' },
        { nodeType: 'fileReference', src: 'file:///private/source.txt' },
        { nodeType: 'note', content: 'type spoof' },
      ])
        expect((await putContent(app, 'c1', 'ref', body)).statusCode).toBe(400);
      expect(
        (
          await putContent(app, 'c1', 'ref', {
            nodeType: 'fileReference',
            label: 'Renamed',
          })
        ).statusCode,
      ).toBe(200);
      expect(store.readNode('ref')).toMatchObject({
        content: '',
        label: 'Renamed',
      });
      const read = await app.inject({ method: 'GET', url: '/canvas/c1' });
      expect(read.statusCode).toBe(200);
      const node = read.json().state.nodes[0];
      expect(node.data.fileReference).toEqual({
        agentletId: 'offline-device',
        path: '/private/source.txt',
      });
      expect(node.data).not.toHaveProperty('content');
      expect(node.data).not.toHaveProperty('src');
      const move = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: store.read()?.version,
          state: {
            nodes: [
              { id: 'ref', type: 'fileReference', position: { x: 5, y: 5 } },
            ],
            edges: [],
          },
        },
      });
      expect(move.statusCode).toBe(200);
      expect(store.read()?.state.nodes).toMatchObject([
        {
          data: {
            fileReference: {
              agentletId: 'offline-device',
              path: '/private/source.txt',
            },
          },
        },
      ]);
      const invalid = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: store.read()?.version,
          state: {
            nodes: [{ id: 'ref', data: { content: 'type-omitted bypass' } }],
            edges: [],
          },
        },
      });
      expect(invalid.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
  it.each(['user', 'agent'])(
    'preserves a current %s Question label against a late preprocessing save',
    async (labelSource) => {
      const app = await buildApp();
      try {
        seedCanvas('c1', 'n1', 'Question');
        await putContent(app, 'c1', 'n1', {
          nodeType: 'question',
          label: 'Protected',
          labelSource,
          content: 'Prompt',
        });
        const response = await putContent(app, 'c1', 'n1', {
          nodeType: 'question',
          label: 'Late automatic',
          labelSource: 'auto',
          summary: 'Independent summary',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().label).toBe('Protected');
        expect(getCanvasStore('c1').readNode('n1')).toMatchObject({
          label: 'Protected',
          labelSource,
          content: 'Prompt',
          summary: 'Independent summary',
        });
      } finally {
        await app.close();
      }
    },
  );

  it('creates a brand-new node when expectRev is the empty-content rev', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'first body',
        expectRev: REV_EMPTY,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ rev: string }>().rev).toBe(
        nodeRevisionOf({ content: 'first body' }),
      );
    } finally {
      await app.close();
    }
  });

  it('accepts a follow-up write that carries the current rev', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      const first = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'v1',
        expectRev: REV_EMPTY,
      });
      const rev1 = first.json<{ rev: string }>().rev;

      const second = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'v2',
        expectRev: rev1,
      });
      expect(second.statusCode).toBe(200);
      expect(second.json<{ rev: string }>().rev).toBe(
        nodeRevisionOf({ content: 'v2' }),
      );
    } finally {
      await app.close();
    }
  });

  it('rejects a write whose expectRev is stale (concurrent edit)', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      // Establish content "v1" on disk.
      await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'v1',
        expectRev: REV_EMPTY,
      });
      // A second writer still believes the node is empty → conflict.
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'racing body',
        expectRev: REV_EMPTY,
      });
      expect(res.statusCode).toBe(409);
      const body = res.json<{ code: string; currentRev: string }>();
      expect(body.code).toBe('NODE_CONTENT_CONFLICT');
      expect(body.currentRev).toBe(nodeRevisionOf({ content: 'v1' }));
    } finally {
      await app.close();
    }
  });

  it('catches a create-race: empty-rev write when a file already exists', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      getCanvasStore('c1').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'already here',
      });
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'my new note',
        expectRev: REV_EMPTY,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
    } finally {
      await app.close();
    }
  });

  it('keeps duplicate sidecars as the existing actionable 409 outcome', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      getCanvasStore('c1').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'body',
      });
      const dir = nodesDir('c1');
      const [original] = readdirSync(dir);
      copyFileSync(join(dir, original), join(dir, 'Duplicate.md'));

      const response = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'must not overwrite either file',
        expectRev: nodeRevisionOf({ content: 'body' }),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe(
        'NODE_DUPLICATE_FILES',
      );
    } finally {
      await app.close();
    }
  });

  it('does not conflict on a label-only change (rev covers content, not label)', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      const first = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'body',
        expectRev: REV_EMPTY,
      });
      const rev1 = first.json<{ rev: string }>().rev;
      // Rename only: same content, same rev → allowed.
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'body',
        label: 'Renamed',
        labelSource: 'user',
        expectRev: rev1,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('skips the CAS entirely when expectRev is omitted', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      getCanvasStore('c1').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'on disk',
      });
      // No expectRev → legacy/non-CAS caller → overwrite allowed.
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'overwrite',
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('ignores expectRev for a derived node type (last-write-wins)', async () => {
    // `pdf` is a `derived` body (bodyOwnership !== 'authored'): its text is
    // produced by preprocessing, not authored in-app, so the server drops
    // any `expectRev` and lets the write land even when the client's baseline
    // is stale — the web sends `expectRev` uniformly but only `authored`
    // types are CAS-guarded. Without this a brand-new pdf's `expectRev`
    // would false-conflict against its own `persist_source` write.
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Doc');
      getCanvasStore('c1').writeNode('n1', {
        nodeId: 'n1',
        type: 'pdf',
        label: 'Doc',
        content: 'extracted text on disk',
      });
      // A stale REV_EMPTY baseline would 409 for an authored node, but a
      // derived node ignores it → the write is accepted (overwrite).
      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'pdf',
        content: 're-extracted text',
        expectRev: REV_EMPTY,
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('PUT /nodes/:nodeId/content — tombstone drops late writes after delete', () => {
  /** Overwrite topology for `canvasId` with exactly `nodes`. */
  function writeStructure(canvasId: string, nodes: unknown[]): void {
    getCanvasStore(canvasId).write({
      canvasId,
      title: null,
      version: 1,
      state: { nodes: nodes as never, edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('drops a late content PUT for a node deleted and gone from structure', async () => {
    // Reproduces the "ghost sidecar" bug: a content PUT (or preprocessing
    // write) still in flight when the node is deleted must not recreate the
    // `nodes/<label>.md` the file watcher would resurface as an external note.
    const app = await buildApp();
    try {
      const store = getCanvasStore('tomb-drop');
      seedCanvas('tomb-drop', 'n1', 'Note'); // n1 present in structure
      store.deleteNode('n1'); // tombstone n1 (no sidecar yet)
      writeStructure('tomb-drop', []); // autosave removed n1 from topology

      const res = await putContent(app, 'tomb-drop', 'n1', {
        nodeType: 'note',
        content: 'ghost body',
      });
      // Benign response so the client (which already removed the node) sees
      // no error toast…
      expect(res.statusCode).toBe(200);
      // …and no sidecar was resurrected on disk.
      expect(store.readNode('n1')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('allows the write again once the node is restored to structure (undo)', async () => {
    const app = await buildApp();
    try {
      const store = getCanvasStore('tomb-undo');
      seedCanvas('tomb-undo', 'n1', 'Note');
      store.deleteNode('n1');
      writeStructure('tomb-undo', []); // gone
      // Undo restores the node into topology → clears the tombstone.
      seedCanvas('tomb-undo', 'n1', 'Note');

      const res = await putContent(app, 'tomb-undo', 'n1', {
        nodeType: 'note',
        content: 'restored body',
      });
      expect(res.statusCode).toBe(200);
      expect(store.readNode('n1')?.content).toBe('restored body');
    } finally {
      await app.close();
    }
  });

  it('does not suppress while the node is still listed in structure', async () => {
    // The presence escape hatch: a tombstone alone must not block a write
    // while topology still lists the node (the delete-before-autosave window
    // and the undo path), otherwise a restored node could be stranded with no
    // sidecar.
    const app = await buildApp();
    try {
      const store = getCanvasStore('tomb-present');
      seedCanvas('tomb-present', 'n1', 'Note');
      store.deleteNode('n1'); // tombstone set, but n1 still in structure

      const res = await putContent(app, 'tomb-present', 'n1', {
        nodeType: 'note',
        content: 'still-alive body',
      });
      expect(res.statusCode).toBe(200);
      expect(store.readNode('n1')?.content).toBe('still-alive body');
    } finally {
      await app.close();
    }
  });

  it('keeps the tombstone through the escape hatch so a later write is still suppressed', async () => {
    // Guards the delete-before-autosave window: the escape hatch lets a write
    // through while the node is transiently still listed, but must NOT clear
    // the tombstone — otherwise a slower in-flight writer that lands after the
    // structural PUT drops the node would resurrect a ghost with no guard
    // left.
    const app = await buildApp();
    try {
      const store = getCanvasStore('tomb-window');
      seedCanvas('tomb-window', 'n1', 'Note');
      store.deleteNode('n1'); // tombstone set; n1 still listed

      // A writer lands while n1 is still in structure → allowed (escape
      // hatch), tombstone kept.
      const during = await putContent(app, 'tomb-window', 'n1', {
        nodeType: 'note',
        content: 'during-window',
      });
      expect(during.statusCode).toBe(200);

      // Structural autosave now removes n1 from topology (tombstone survives:
      // n1 is not in the new node list, so write() does not clear it).
      writeStructure('tomb-window', []);

      // A later in-flight writer must be suppressed — proving the tombstone
      // outlived the escape hatch. The on-disk body stays at the earlier
      // value; the later write was dropped rather than applied.
      const after = await putContent(app, 'tomb-window', 'n1', {
        nodeType: 'note',
        content: 'ghost-after-window',
      });
      expect(after.statusCode).toBe(200);
      expect(store.readNode('n1')?.content).toBe('during-window');
    } finally {
      await app.close();
    }
  });
});

describe('missing-sidecar barrier', () => {
  function seedNodeWithoutSidecar(
    canvasId: string,
    nodeId: string,
    nodeType: string,
  ): void {
    getCanvasStore(canvasId).write({
      canvasId,
      title: null,
      version: 1,
      state: {
        nodes: [
          { id: nodeId, type: nodeType, position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('hydrates a PDF without its sidecar as contentMissing', async () => {
    const app = await buildApp();
    try {
      seedNodeWithoutSidecar('pdf-missing', 'pdf1', 'pdf');

      const response = await app.inject({
        method: 'GET',
        url: '/canvas/pdf-missing',
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json<{
        state: { nodes: Array<{ data?: { contentMissing?: boolean } }> };
      }>();
      expect(payload.state.nodes[0]?.data?.contentMissing).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each(['frame', 'sketch'])(
    'hydrates a %s without its sidecar as contentMissing',
    async (nodeType) => {
      const app = await buildApp();
      try {
        const canvasId = `${nodeType}-missing`;
        const nodeId = `${nodeType}1`;
        seedNodeWithoutSidecar(canvasId, nodeId, nodeType);

        const response = await app.inject({
          method: 'GET',
          url: `/canvas/${canvasId}`,
        });

        expect(response.statusCode).toBe(200);
        const payload = response.json<{
          state: { nodes: Array<{ data?: { contentMissing?: boolean } }> };
        }>();
        expect(payload.state.nodes[0]?.data?.contentMissing).toBe(true);
      } finally {
        await app.close();
      }
    },
  );

  it('does not recreate the missing sidecar through preprocessing', async () => {
    const app = await buildApp();
    try {
      seedNodeWithoutSidecar('pdf-preprocess', 'pdf1', 'pdf');
      const store = getCanvasStore('pdf-preprocess');

      const response = await app.inject({
        method: 'POST',
        url: '/canvas/pdf-preprocess/nodes/pdf1/preprocess',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'pdf',
          trigger: 'node_updated',
          snapshot: {},
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ success: boolean }>().success).toBe(false);
      expect(store.readNode('pdf1')).toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('artifact presence hydration', () => {
  function seedImageWithSidecar(canvasId: string, src: string): void {
    const store = getCanvasStore(canvasId);
    store.write({
      canvasId,
      title: null,
      version: 1,
      state: {
        nodes: [
          {
            id: 'image1',
            type: 'image',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    store.writeNode('image1', {
      nodeId: 'image1',
      type: 'image',
      label: 'Image',
      src,
      content: '',
    });
  }

  function blobStore(scope: BlobScope): BlobStore {
    return {
      kind: 'disk',
      async init() {},
      async health() {
        return { ok: true, kind: 'disk' };
      },
      async close() {},
      space: () => ({
        artifacts: scope,
        guide: scope,
        memory: scope,
        uploads: scope,
      }),
    };
  }

  it('batches only artifact keys referenced by hydrated sidecars', async () => {
    seedImageWithSidecar('artifact-batch', 'present.png');
    const hasMany = vi.fn(async (names: readonly string[]) => new Set(names));
    const current = getStorage();
    const restore = setStorageForTesting({
      ...current,
      blobs: blobStore({ hasMany } as unknown as BlobScope),
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/canvas/artifact-batch',
      });

      expect(response.statusCode).toBe(200);
      expect(hasMany).toHaveBeenCalledOnce();
      expect(hasMany).toHaveBeenCalledWith(['present.png']);
    } finally {
      await app.close();
      restore();
    }
  });

  it('propagates a failed artifact batch instead of marking files missing', async () => {
    seedImageWithSidecar('artifact-failure', 'present.png');
    const current = getStorage();
    const restore = setStorageForTesting({
      ...current,
      blobs: blobStore({
        hasMany: vi.fn(() => Promise.reject(new Error('backend unavailable'))),
      } as unknown as BlobScope),
    });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/canvas/artifact-failure',
      });
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
      restore();
    }
  });
});
