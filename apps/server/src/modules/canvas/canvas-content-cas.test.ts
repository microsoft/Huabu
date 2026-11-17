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
import syncRoutes from './sync.route.js';
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
  await app.register(syncRoutes, { prefix: '/canvas' });
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

describe('content saved after a load', () => {
  /** Add a second note to the seeded Space's record. */
  function addNote(canvasId: string, nodeId: string): void {
    const store = getCanvasStore(canvasId);
    const record = store.read();
    if (!record) throw new Error('Space is missing');
    store.write({
      ...record,
      state: {
        ...record.state,
        nodes: [
          ...record.state.nodes,
          {
            id: nodeId,
            type: 'note',
            position: { x: 0, y: 200 },
            data: { label: nodeId },
          },
        ],
      },
    });
  }

  it('is named when asked from the position that load carried: a body, and a title alone', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      addNote('c1', 'n2');
      for (const nodeId of ['n1', 'n2'])
        expect(
          (
            await putContent(app, 'c1', nodeId, {
              nodeType: 'note',
              content: `first ${nodeId}`,
              expectRev: REV_EMPTY,
            })
          ).statusCode,
        ).toBe(200);

      // A page loads the Space. Its stream is not open yet.
      const loaded = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json() as {
        version: number;
        contentPosition: { epoch: string; seq: number };
      };
      expect(loaded.contentPosition).toEqual({
        epoch: expect.any(String),
        seq: expect.any(Number),
      });
      const changesSince = async (position: { epoch: string; seq: number }) =>
        (
          await app.inject({
            method: 'GET',
            url: `/canvas/c1/content/changes?epoch=${encodeURIComponent(position.epoch)}&seq=${position.seq}`,
          })
        ).json() as {
          position: { epoch: string; seq: number };
          changedNodeIds?: string[];
          reset?: boolean;
        };

      // Another page saves a body, and on the other node a title only.
      // Neither changes the Space version.
      const first = await app.inject({
        method: 'GET',
        url: '/canvas/c1/nodes/n1/content',
      });
      expect(
        (
          await putContent(app, 'c1', 'n1', {
            nodeType: 'note',
            content: 'saved in the gap',
            expectRev: (first.json() as { rev: string }).rev,
            pageId: 'another-page',
          })
        ).statusCode,
      ).toBe(200);
      const second = await app.inject({
        method: 'GET',
        url: '/canvas/c1/nodes/n2/content',
      });
      expect(
        (
          await putContent(app, 'c1', 'n2', {
            nodeType: 'note',
            label: 'Renamed in the gap',
            labelSource: 'user',
            expectRev: (second.json() as { rev: string }).rev,
            pageId: 'another-page',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          (await app.inject({ method: 'GET', url: '/canvas/c1' })).json() as {
            version: number;
          }
        ).version,
      ).toBe(loaded.version);

      const answer = await changesSince(loaded.contentPosition);
      expect(answer.reset).toBeUndefined();
      expect(answer.changedNodeIds).toEqual(
        expect.arrayContaining(['n1', 'n2']),
      );
      // The answer's position is the one a load made now would carry.
      const reloaded = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json() as { contentPosition: { epoch: string; seq: number } };
      expect(answer.position).toEqual(reloaded.contentPosition);
    } finally {
      await app.close();
    }
  });
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
      // A page adds nodes through `execute`; there is no whole-Space save.
      const create = (data: Record<string, unknown>) =>
        app.inject({
          method: 'POST',
          url: '/canvas/c1/execute',
          payload: {
            originator: { source: 'ui' },
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id: pdf.id,
                    nodeType: 'pdf',
                    position: pdf.position,
                    data,
                    selectOnCreate: false,
                  },
                ],
              },
            ],
          },
        });
      expect(independent).toMatchObject({ id: 'node-existing' });
      const claimed = await create({ noteNodeId: 'node-existing' });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().results).toEqual([
        expect.objectContaining({ applied: false, reason: 'invalid-target' }),
      ]);
      expect(store.read()?.version).toBe(1);
      const addedPdf = await create({});
      expect(addedPdf.statusCode).toBe(200);
      expect(addedPdf.json().results).toEqual([
        expect.objectContaining({ applied: true }),
      ]);
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
    {
      // The seeded node is the PDF; another Note stands on its own.
      const store = getCanvasStore('c1');
      const record = store.read();
      if (!record) throw new Error('Missing seeded Space');
      store.write({
        ...record,
        state: {
          ...record.state,
          nodes: [
            { id: 'pdf', type: 'pdf', position: { x: 0, y: 0 }, data: {} },
            {
              id: 'other-notes',
              type: 'note',
              position: { x: 0, y: 0 },
              data: {},
            },
          ],
        },
      });
    }
    const app = await buildApp();
    try {
      // Every structure change is a page's `execute` batch; the whole-Space
      // save these cases once went through no longer exists.
      const execute = async (commands: unknown[]) => {
        const response = await app.inject({
          method: 'POST',
          url: '/canvas/c1/execute',
          payload: { originator: { source: 'ui' }, commands },
        });
        expect(response.statusCode).toBe(200);
        return response.json<{
          toVersion: number;
          fromVersion: number;
          results: Array<{ applied: boolean; reason?: string }>;
        }>();
      };
      const load = async () =>
        (
          await app.inject({ method: 'GET', url: '/canvas/c1' })
        ).json<GetCanvasResponse>();
      const link = (noteNodeId: string) => ({
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: 'pdf', patch: { noteNodeId } }],
      });

      const linked = await execute([
        { type: 'INITIALIZE_PDF_NOTE', nodeId: 'pdf', noteId: 'notes' },
      ]);
      expect(linked.results).toEqual([
        expect.objectContaining({ applied: true }),
      ]);
      const created = await load();
      const saved = await putContent(app, 'c1', 'notes', {
        nodeType: 'note',
        content: 'My independently stored notes',
        label: 'Reading notes',
        expectRev: created.nodeContentRevisions?.notes,
      });
      expect(saved.statusCode).toBe(200);
      const loaded = await load();
      expect(loaded.state).toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'pdf',
            data: expect.objectContaining({ noteNodeId: 'notes' }),
          }),
          expect.objectContaining({
            id: 'notes',
            hidden: true,
            data: expect.objectContaining({
              content: 'My independently stored notes',
            }),
          }),
        ]),
      });

      // A link to a Note that does not exist, a second Note for the same
      // PDF, and dropping the link while the Note stays are all refused,
      // and none of them changes the Space.
      for (const command of [
        link('missing'),
        link('other-notes'),
        {
          type: 'MERGE_NODE_DATA',
          patches: [{ nodeId: 'pdf', patch: {}, unset: ['noteNodeId'] }],
        },
        { type: 'SET_NODE_PARENT', nodeIds: ['notes'], parentId: 'pdf' },
      ]) {
        const rejected = await execute([command]);
        expect(rejected.results).toEqual([
          expect.objectContaining({ applied: false, reason: 'invalid-target' }),
        ]);
        expect(rejected.toVersion).toBe(loaded.version);
      }
      // Replacing the Note in one batch is refused where the new link is
      // stated; the PDF never ends up owning somebody else's Note.
      const replaced = await execute([
        { type: 'DELETE_NODES', nodeIds: ['notes'] },
        link('other-notes'),
      ]);
      expect(replaced.results).toEqual([
        expect.objectContaining({ applied: true }),
        expect.objectContaining({ applied: false, reason: 'invalid-target' }),
      ]);

      // Deleting the Note is how the link is dropped.
      const withoutNote = await load();
      expect(withoutNote.state).toMatchObject({
        nodes: [
          {
            id: 'pdf',
            data: expect.not.objectContaining({ noteNodeId: 'notes' }),
          },
          { id: 'other-notes' },
        ],
      });

      // And a PDF cannot be removed leaving its Note behind.
      await execute([
        { type: 'INITIALIZE_PDF_NOTE', nodeId: 'pdf', noteId: 'notes-again' },
      ]);
      const removed = await execute([
        { type: 'DELETE_NODES', nodeIds: ['pdf'] },
      ]);
      expect(removed.results).toEqual([
        expect.objectContaining({ applied: true }),
      ]);
      expect((await load()).state).toMatchObject({
        nodes: [{ id: 'other-notes' }],
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

  it('loads the canonical PDF revision without its extracted body; property saves neither need nor move it', async () => {
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
      // Four property saves later the revision is still the one of the text.
      expect(reordered.json().rev).toBe(created.json().rev);
      expect(reordered.json().rev).toBe(
        nodeRevisionOf({
          type: 'pdf',
          content: 'Extracted PDF text that is not sent to the canvas.',
        }),
      );
      // A page that hashes the node it holds (no body) has another revision.
      // It does not matter: a property save is not checked against one.
      const visible = (afterReorder.state as { nodes: Array<{ data: object }> })
        .nodes[0].data;
      const derived = nodeRevisionOf({ ...visible, type: 'pdf' });
      expect(derived).not.toBe(reordered.json().rev);
      for (const expectRev of [derived, 'no-such-revision', undefined]) {
        const edit = await putContent(app, 'c1', 'pdf', {
          nodeType: 'pdf',
          properties: { Status: `Done ${expectRev}` },
          ...(expectRev !== undefined ? { expectRev } : {}),
        });
        expect(edit.statusCode).toBe(200);
        expect(edit.json().rev).toBe(created.json().rev);
      }
      expect(store.readNode('pdf')?.properties).toEqual({
        Venue: 'CHI 25',
        Status: 'Done undefined',
      });
      expect(store.readNode('pdf')?.content).toBe(
        'Extracted PDF text that is not sent to the canvas.',
      );
    } finally {
      await app.close();
    }
  });

  it('round-trips PDF properties with key deletion, whatever revision the save quotes', async () => {
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
      // The revision is the body's: the property save did not move it, and a
      // property save that quotes any other is applied all the same.
      expect(second.json().rev).toBe(first.json().rev);
      expect(
        (
          await putContent(app, 'c1', 'pdf', {
            nodeType: 'pdf',
            expectRev: 'a-revision-from-before',
            properties: { authors: null },
          })
        ).statusCode,
      ).toBe(200);
      expect(store.readNode('pdf')?.properties).toEqual({ reviewed: true });
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

  it('names the saving page on the notification and serves what the other pages then fetch', async () => {
    const app = await buildApp();
    const received = vi.fn();
    const unsubscribe = subscribeCanvasUpdates('c1', received);
    try {
      seedCanvas('c1', 'n1', 'Note');
      const provenance = { blocks: [{ id: 'b1', source: 'agent' }] };
      const saved = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'from page A',
        label: 'Renamed',
        labelSource: 'user',
        summary: 'A summary',
        keywords: ['one', 'two'],
        provenance,
        expectRev: REV_EMPTY,
        pageId: 'page-a',
      });
      expect(saved.statusCode).toBe(200);
      expect(received).toHaveBeenCalledExactlyOnceWith({
        type: 'invalidate',
        data: { nodeIds: ['n1'], originPageId: 'page-a' },
      });

      const fetched = await app.inject({
        method: 'GET',
        url: '/canvas/c1/nodes/n1/content',
      });
      expect(fetched.statusCode).toBe(200);
      // The page id is routing information, never stored with the node.
      expect(fetched.json()).toEqual({
        nodeId: 'n1',
        type: 'note',
        label: 'Renamed',
        labelSource: 'user',
        content: 'from page A',
        rev: saved.json().rev,
        summary: 'A summary',
        keywords: ['one', 'two'],
        provenance,
      });
      expect(saved.json().rev).toBe(nodeRevisionOf({ content: 'from page A' }));

      // A page id that is not a short string is refused, not relayed.
      expect(
        (
          await putContent(app, 'c1', 'n1', {
            nodeType: 'note',
            content: 'again',
            expectRev: saved.json().rev,
            pageId: 'x'.repeat(65),
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('keeps both when two pages edit different properties of one node, although neither had read the other', async () => {
    const app = await buildApp();
    const received = vi.fn();
    const unsubscribe = subscribeCanvasUpdates('c1', received);
    try {
      seedCanvas('c1', 'n1', 'Note');
      const base = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'body',
        expectRev: REV_EMPTY,
      });
      const position = (
        await app.inject({ method: 'GET', url: '/canvas/c1' })
      ).json<GetCanvasResponse>().contentPosition;
      received.mockClear();

      // Page A adds tags. Page B, which has not fetched that yet, sets a
      // status from the revision both started from: applied as well, since
      // each save patches its own key of what the server holds.
      const fromA = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        expectRev: base.json().rev,
        properties: { tags: ['physics'] },
        pageId: 'page-a',
      });
      expect(fromA.statusCode).toBe(200);
      const fromB = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        expectRev: base.json().rev,
        properties: { status: 'read' },
        pageId: 'page-b',
      });
      expect(fromB.statusCode).toBe(200);
      expect(received.mock.calls).toEqual([
        [
          {
            type: 'invalidate',
            data: { nodeIds: ['n1'], originPageId: 'page-a' },
          },
        ],
        [
          {
            type: 'invalidate',
            data: { nodeIds: ['n1'], originPageId: 'page-b' },
          },
        ],
      ]);
      // The body's revision is where it was.
      expect(fromA.json().rev).toBe(base.json().rev);
      expect(fromB.json().rev).toBe(base.json().rev);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: '/canvas/c1/nodes/n1/content',
          })
        ).json(),
      ).toMatchObject({
        content: 'body',
        properties: { tags: ['physics'], status: 'read' },
        rev: base.json().rev,
      });

      // A page that was not connected meanwhile is told to fetch the node.
      const changes = await app.inject({
        method: 'GET',
        url: `/canvas/c1/content/changes?epoch=${encodeURIComponent(position?.epoch ?? '')}&seq=${position?.seq}`,
      });
      expect(changes.statusCode).toBe(200);
      expect(changes.json().changedNodeIds).toEqual(['n1']);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  describe('custom properties are not versioned', () => {
    const fetchNode = async (app: Awaited<ReturnType<typeof buildApp>>) =>
      (
        await app.inject({ method: 'GET', url: '/canvas/c1/nodes/n1/content' })
      ).json();
    const seedBody = async (app: Awaited<ReturnType<typeof buildApp>>) => {
      seedCanvas('c1', 'n1', 'Note');
      const saved = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: 'v1',
        expectRev: REV_EMPTY,
      });
      expect(saved.statusCode).toBe(200);
      return saved.json().rev as string;
    };

    it('applies a property patch although the body revision it quotes is stale, or none is quoted', async () => {
      const app = await buildApp();
      try {
        const rev1 = await seedBody(app);
        // Someone else saves the body.
        const body2 = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'v2',
          expectRev: rev1,
        });
        const rev2 = body2.json().rev as string;
        expect(rev2).not.toBe(rev1);

        const stale = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          properties: { tags: ['physics'] },
          propertyDisplayKeys: ['tags'],
          expectRev: rev1,
        });
        expect(stale.statusCode).toBe(200);
        // The answer names the body's current revision; the patch left it.
        expect(stale.json().rev).toBe(rev2);
        const unversioned = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          properties: { status: 'read' },
        });
        expect(unversioned.statusCode).toBe(200);
        expect(await fetchNode(app)).toMatchObject({
          content: 'v2',
          label: null,
          properties: { tags: ['physics'], status: 'read' },
          propertyDisplayKeys: ['tags'],
          rev: rev2,
        });
      } finally {
        await app.close();
      }
    });

    it('accepts a body save that quotes the revision from before somebody changed a property', async () => {
      const app = await buildApp();
      try {
        const rev1 = await seedBody(app);
        // An agent, or another page, tags the note while this page types.
        expect(
          (
            await putContent(app, 'c1', 'n1', {
              nodeType: 'note',
              properties: { tags: ['physics'] },
            })
          ).statusCode,
        ).toBe(200);
        await executeOnServer({
          canvasId: 'c1',
          originator: { source: 'agent', threadId: 't' },
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                {
                  nodeId: 'n1' as never,
                  patch: { properties: { status: 'read' } },
                },
              ],
            },
          ],
        });
        const typed = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'v1, typed on',
          expectRev: rev1,
        });
        expect(typed.statusCode).toBe(200);
        expect(await fetchNode(app)).toMatchObject({
          content: 'v1, typed on',
          properties: { tags: ['physics'], status: 'read' },
        });
      } finally {
        await app.close();
      }
    });

    it('still refuses a stale body, with or without properties beside it', async () => {
      const app = await buildApp();
      const received = vi.fn();
      const unsubscribe = subscribeCanvasUpdates('c1', received);
      try {
        const rev1 = await seedBody(app);
        const body2 = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'v2',
          expectRev: rev1,
        });
        const rev2 = body2.json().rev as string;
        received.mockClear();

        const staleBody = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'stale',
          expectRev: rev1,
        });
        expect(staleBody.statusCode).toBe(409);
        expect(staleBody.json()).toMatchObject({
          code: 'NODE_CONTENT_CONFLICT',
          currentRev: rev2,
        });
        expect(staleBody.json()).not.toHaveProperty('propertiesApplied');
        expect(received).not.toHaveBeenCalled();

        // Body and properties in one request, body stale: the body, title
        // and summary are refused; the property patch is written.
        const both = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'stale',
          label: 'Stale title',
          summary: 'stale summary',
          properties: { tags: ['physics'], gone: null },
          propertyDisplayKeys: ['tags'],
          expectRev: rev1,
          pageId: 'page-a',
        });
        expect(both.statusCode).toBe(409);
        expect(both.json()).toMatchObject({
          code: 'NODE_CONTENT_CONFLICT',
          currentRev: rev2,
          expectedRev: rev1,
          propertiesApplied: true,
        });
        expect(received).toHaveBeenCalledExactlyOnceWith({
          type: 'invalidate',
          data: { nodeIds: ['n1'], originPageId: 'page-a' },
        });
        const stored = await fetchNode(app);
        expect(stored).toMatchObject({
          content: 'v2',
          label: null,
          properties: { tags: ['physics'] },
          propertyDisplayKeys: ['tags'],
          rev: rev2,
        });
        expect(stored).not.toHaveProperty('summary');

        // A label-only save of an authored node is checked as before.
        expect(
          (
            await putContent(app, 'c1', 'n1', {
              nodeType: 'note',
              label: 'Renamed',
              expectRev: rev1,
            })
          ).statusCode,
        ).toBe(409);
      } finally {
        unsubscribe();
        await app.close();
      }
    });

    it('writes body and properties of one request together when the body revision is current', async () => {
      const app = await buildApp();
      try {
        const rev1 = await seedBody(app);
        const both = await putContent(app, 'c1', 'n1', {
          nodeType: 'note',
          content: 'v2',
          properties: { tags: ['physics'] },
          expectRev: rev1,
        });
        expect(both.statusCode).toBe(200);
        expect(both.json().rev).toBe(nodeRevisionOf({ content: 'v2' }));
        expect(await fetchNode(app)).toMatchObject({
          content: 'v2',
          properties: { tags: ['physics'] },
        });
      } finally {
        await app.close();
      }
    });

    it('lets the last writer of one key win, and keeps a whole list value as one value', async () => {
      const app = await buildApp();
      try {
        const rev1 = await seedBody(app);
        const put = (properties: Record<string, unknown>) =>
          putContent(app, 'c1', 'n1', {
            nodeType: 'note',
            properties,
            expectRev: rev1,
          });
        expect((await put({ status: 'first' })).statusCode).toBe(200);
        expect((await put({ status: 'second' })).statusCode).toBe(200);
        // A list is one value: two writers that each add an item to the list
        // they saw replace it, they do not merge item by item.
        expect((await put({ tags: ['a', 'b'] })).statusCode).toBe(200);
        expect((await put({ tags: ['a', 'c'] })).statusCode).toBe(200);
        expect((await fetchNode(app)).properties).toEqual({
          status: 'second',
          tags: ['a', 'c'],
        });
        // Removing a key that somebody else already removed is not an error.
        expect((await put({ status: null })).statusCode).toBe(200);
        expect((await put({ status: null })).statusCode).toBe(200);
        expect((await fetchNode(app)).properties).toEqual({ tags: ['a', 'c'] });
      } finally {
        await app.close();
      }
    });
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
        method: 'POST',
        url: '/canvas/c1/execute',
        payload: {
          originator: { source: 'ui' },
          commands: [
            {
              type: 'SET_NODE_GEOMETRY',
              items: [{ nodeId: 'ref', position: { x: 5, y: 5 } }],
            },
          ],
        },
      });
      expect(move.statusCode).toBe(200);
      expect(store.read()?.state.nodes).toMatchObject([
        {
          position: { x: 5, y: 5 },
          data: {
            fileReference: {
              agentletId: 'offline-device',
              path: '/private/source.txt',
            },
          },
        },
      ]);
      // A structure edit names no node type, so it cannot spoof one: what
      // the stored node is decides, and a body is refused.
      const version = store.read()?.version;
      const invalid = await app.inject({
        method: 'POST',
        url: '/canvas/c1/execute',
        payload: {
          originator: { source: 'ui' },
          commands: [
            {
              type: 'MERGE_NODE_DATA',
              patches: [
                { nodeId: 'ref', patch: { content: 'type-omitted bypass' } },
              ],
            },
          ],
        },
      });
      expect(invalid.statusCode).toBe(200);
      expect(invalid.json().results[0].applied).toBe(false);
      expect(store.read()?.version).toBe(version);
      expect(store.readNode('ref')).toMatchObject({ content: '' });
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
