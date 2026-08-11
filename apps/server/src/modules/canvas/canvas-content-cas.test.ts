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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { subscribeCanvasUpdates } from './canvas-sync.js';
import canvasRoutes from './canvas.route.js';
import { getPreprocessDispatcher } from '../preprocessing/index.js';
import {
  getCanvasStore,
  getStorage,
  getStructuredStore,
  setStorageForTesting,
} from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { BlobScope, BlobStore } from '../storage/index.js';

let tmp: string;

const REV_EMPTY = nodeRevisionOf({});

async function buildApp() {
  const app = fastify();
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

/** Seed topology with a single note node (no `.md` body yet). */
function seedCanvas(
  canvasId: string,
  nodeId: string,
  label: string,
  nodeType = 'note',
): void {
  getCanvasStore(canvasId).write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: nodeId,
          type: nodeType,
          position: { x: 0, y: 0 },
          data: { label },
        },
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
  it('creates the first sidecar for an acknowledged topology node', async () => {
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

  it('co-delivers the canonical body when an empty clobber is preserved', async () => {
    const app = await buildApp();
    try {
      seedCanvas('c1', 'n1', 'Note');
      getCanvasStore('c1').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'keep me',
      });
      const currentRev = nodeRevisionOf({ content: 'keep me' });

      const res = await putContent(app, 'c1', 'n1', {
        nodeType: 'note',
        content: '',
        expectRev: currentRev,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        contentPreserved: true,
        content: 'keep me',
        rev: currentRev,
      });
      expect(getCanvasStore('c1').readNode('n1')?.content).toBe('keep me');
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
      seedCanvas('c1', 'n1', 'Doc', 'pdf');
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

  it('does not create a sidecar for a node absent from topology', async () => {
    const app = await buildApp();
    try {
      getCanvasStore('orphan-create').write({
        canvasId: 'orphan-create',
        title: null,
        version: 1,
        state: { nodes: [], edges: [] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await putContent(app, 'orphan-create', 'n1', {
        nodeType: 'note',
        content: 'must not become an orphan',
        expectRev: REV_EMPTY,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
      expect(getCanvasStore('orphan-create').readNode('n1')).toBeNull();
      expect(getCanvasStore('orphan-create').read()?.version).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rejects a stale node type without rewriting canonical frontmatter', async () => {
    const app = await buildApp();
    try {
      seedCanvas('type-conflict', 'n1', 'Note', 'note');
      getCanvasStore('type-conflict').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'canonical body',
      });

      const res = await putContent(app, 'type-conflict', 'n1', {
        nodeType: 'text',
        content: 'stale request',
        expectRev: nodeRevisionOf({ content: 'canonical body' }),
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
      expect(getCanvasStore('type-conflict').readNode('n1')).toMatchObject({
        type: 'note',
        content: 'canonical body',
      });
      expect(getCanvasStore('type-conflict').read()?.version).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /nodes/:nodeId/content — canonical record baseline', () => {
  it('co-delivers the authoritative whole-record revision with its snapshot', async () => {
    seedCanvas('targeted-read', 'n1', 'Note');
    getCanvasStore('targeted-read').writeNode('n1', {
      nodeId: 'n1',
      type: 'note',
      label: 'Canonical label',
      labelSource: 'user',
      content: 'canonical body',
      summary: 'Canonical summary',
    });
    const expected = await getStructuredStore()
      .space('targeted-read')
      .nodes.read('n1');
    if (!expected) throw new Error('Expected seeded node snapshot');

    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/canvas/targeted-read/nodes/n1/content',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        nodeId: 'n1',
        label: expected.record.label,
        labelSource: expected.record.labelSource,
        content: expected.record.content,
        summary: expected.record.summary,
        recordRevision: expected.revision,
      });
    } finally {
      await app.close();
    }
  });
});

describe('standalone node mutations — aggregate commit publication', () => {
  it('bumps once, appends one durable row, acknowledges, then publishes PUT', async () => {
    const app = await buildApp();
    const updates: unknown[] = [];
    const unsubscribe = subscribeCanvasUpdates('commit-put', (event) =>
      updates.push(event),
    );
    try {
      seedCanvas('commit-put', 'n1', 'Note');
      const response = await putContent(app, 'commit-put', 'n1', {
        nodeType: 'note',
        content: 'durable body',
        expectRev: REV_EMPTY,
        originator: { source: 'ui', tabId: 'tab-put' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        recordRevision: string;
        commit: { commitId: string };
        ack: {
          commitId: string;
          fromVersion: number;
          toVersion: number;
          recordChanged: boolean;
        };
      }>();
      expect(body.ack).toMatchObject({
        fromVersion: 1,
        toVersion: 2,
        recordChanged: true,
      });
      expect(body.commit.commitId).toBe(body.ack.commitId);
      expect(getCanvasStore('commit-put').read()?.version).toBe(2);

      const rows = getCanvasStore('commit-put').readDeltaLogSince(0);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(2);
      expect(rows[0]?.commit?.commitId).toBe(body.ack.commitId);
      expect(rows[0]?.commit?.originator).toEqual({
        source: 'ui',
        tabId: 'tab-put',
      });
      expect(rows[0]?.commit?.nodeChanges[0]).toMatchObject({
        kind: 'inline',
        nodeId: 'n1',
        recordRevision: body.recordRevision,
      });

      const snapshot = await getStructuredStore()
        .space('commit-put')
        .nodes.read('n1');
      expect(snapshot?.revision).toBe(body.recordRevision);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        type: 'update',
        data: {
          fromVersion: 1,
          toVersion: 2,
          pendingEffects: {
            mutatedNodes: [],
            deletedNodeIds: [],
            contentEditedNodeIds: [],
          },
          commit: { commitId: body.ack.commitId },
        },
      });
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('returns a no-op ack without a version, row, or publication', async () => {
    const app = await buildApp();
    try {
      seedCanvas('commit-noop', 'n1', 'Note');
      const first = await putContent(app, 'commit-noop', 'n1', {
        nodeType: 'note',
        content: 'same body',
        expectRev: REV_EMPTY,
      });
      const firstBody = first.json<{ rev: string }>();
      const updates: unknown[] = [];
      const unsubscribe = subscribeCanvasUpdates('commit-noop', (event) =>
        updates.push(event),
      );
      try {
        const second = await putContent(app, 'commit-noop', 'n1', {
          nodeType: 'note',
          content: 'same body',
          expectRev: firstBody.rev,
        });

        expect(second.statusCode).toBe(200);
        expect(second.json<{ ack: unknown }>().ack).toMatchObject({
          fromVersion: 2,
          toVersion: 2,
          recordChanged: false,
        });
        expect(getCanvasStore('commit-noop').read()?.version).toBe(2);
        expect(getCanvasStore('commit-noop').readDeltaLogSince(0)).toHaveLength(
          1,
        );
        expect(updates).toEqual([]);
      } finally {
        unsubscribe();
      }
    } finally {
      await app.close();
    }
  });

  it('atomically deletes topology, incident edges, sidecar, row, and publication', async () => {
    const app = await buildApp();
    const updates: unknown[] = [];
    const unsubscribe = subscribeCanvasUpdates('commit-delete', (event) =>
      updates.push(event),
    );
    try {
      seedCanvas('commit-delete', 'n1', 'Note');
      const store = getCanvasStore('commit-delete');
      const seeded = store.read();
      if (seeded === null) throw new Error('seed Space disappeared');
      store.write({
        ...seeded,
        state: {
          nodes: [
            ...seeded.state.nodes,
            {
              id: 'n2',
              type: 'note',
              position: { x: 100, y: 0 },
              data: { label: 'Keep' },
            },
          ],
          edges: [{ id: 'e1', source: 'n1', target: 'n2', type: 'default' }],
        },
      });
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'delete me',
      });

      const response = await app.inject({
        method: 'DELETE',
        url: '/canvas/commit-delete/nodes/n1',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          originator: { source: 'ui', tabId: 'tab-delete' },
        }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        commit: { commitId: string };
        ack: { commitId: string; fromVersion: number; toVersion: number };
      }>();
      expect(body.ack).toMatchObject({ fromVersion: 1, toVersion: 2 });
      expect(body.commit.commitId).toBe(body.ack.commitId);
      expect(store.read()?.version).toBe(2);
      expect(
        (store.read()?.state.nodes as Array<{ id: string }>).map(
          (node) => node.id,
        ),
      ).toEqual(['n2']);
      expect(store.read()?.state.edges).toEqual([]);
      expect(store.readNode('n1')).toBeNull();
      const rows = store.readDeltaLogSince(0);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deltas).toMatchObject([
        { type: 'DELETE_NODE', node: { id: 'n1' } },
        { type: 'DELETE_EDGE', edge: { id: 'e1' } },
      ]);
      expect(rows[0]?.commit).toMatchObject({
        commitId: body.ack.commitId,
        structureDeltas: [
          { type: 'DELETE_NODE', node: { id: 'n1' } },
          { type: 'DELETE_EDGE', edge: { id: 'e1' } },
        ],
        nodeChanges: [{ kind: 'delete', nodeId: 'n1' }],
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        type: 'update',
        data: {
          pendingEffects: { deletedNodeIds: ['n1'] },
          commit: { commitId: body.ack.commitId },
        },
      });
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('keeps absent DELETE a no-op while tombstoning against a late PUT', async () => {
    const app = await buildApp();
    const updates: unknown[] = [];
    const unsubscribe = subscribeCanvasUpdates('delete-absent', (event) =>
      updates.push(event),
    );
    try {
      seedCanvas('delete-absent', 'n1', 'Note');
      const store = getCanvasStore('delete-absent');
      const seeded = store.read();
      if (seeded === null) throw new Error('seed Space disappeared');
      store.write({
        ...seeded,
        state: { ...seeded.state, nodes: [] },
      });
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/canvas/delete-absent/nodes/n1',
      });

      expect(deleted.statusCode).toBe(200);
      expect(deleted.json<{ ack: unknown }>().ack).toMatchObject({
        fromVersion: 1,
        toVersion: 1,
        recordChanged: false,
      });
      expect(store.read()?.version).toBe(1);
      expect(store.readDeltaLogSince(0)).toEqual([]);
      expect(updates).toEqual([]);

      const late = await putContent(app, 'delete-absent', 'n1', {
        nodeType: 'note',
        content: 'late ghost',
      });
      expect(late.statusCode).toBe(409);
      expect(late.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
      expect(store.readNode('n1')).toBeNull();
      expect(store.read()?.version).toBe(1);
      expect(store.readDeltaLogSince(0)).toEqual([]);
    } finally {
      unsubscribe();
      await app.close();
    }
  });
});

describe('PUT /:canvasId — structural SpaceCommit', () => {
  function seedStructure(
    canvasId: string,
    state: { nodes: unknown[]; edges: unknown[]; [key: string]: unknown },
  ): void {
    getCanvasStore(canvasId).write({
      canvasId,
      title: 'Structure',
      version: 1,
      state,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  it('atomically creates topology plus its first sidecar and returns the durable event', async () => {
    const app = await buildApp();
    const updates: unknown[] = [];
    const unsubscribe = subscribeCanvasUpdates('struct-create', (event) =>
      updates.push(event),
    );
    try {
      seedStructure('struct-create', {
        nodes: [],
        edges: [],
        serverOwned: 'keep-me',
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-create',
        payload: {
          version: 1,
          title: 'Structure',
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 10, y: 20 },
                data: {
                  label: 'First note',
                  labelSource: 'auto',
                  content: 'first body',
                },
              },
            ],
            edges: [],
            serverOwned: 'stale-client-copy',
          },
          originator: { source: 'ui', tabId: 'tab-create' },
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        version: number;
        ack: { commitId: string };
        commit: {
          commitId: string;
          nodeChanges: Array<Record<string, unknown>>;
        };
      }>();
      expect(body.version).toBe(2);
      expect(body.commit.commitId).toBe(body.ack.commitId);
      expect(body.commit.nodeChanges).toMatchObject([
        { kind: 'inline', nodeId: 'n1' },
      ]);

      const store = getCanvasStore('struct-create');
      expect(store.read()).toMatchObject({
        version: 2,
        state: {
          serverOwned: 'keep-me',
          nodes: [
            {
              id: 'n1',
              data: {},
            },
          ],
        },
      });
      expect(store.readNode('n1')).toMatchObject({
        label: 'First note',
        content: 'first body',
      });
      const rows = store.readDeltaLogSince(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.commit?.commitId).toBe(body.commit.commitId);
      expect(updates).toHaveLength(1);
    } finally {
      unsubscribe();
      await app.close();
    }
  });

  it('rejects attaching an incompatible orphan sidecar to new topology', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-orphan-type', { nodes: [], edges: [] });
      const store = getCanvasStore('struct-orphan-type');
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'External note',
        content: 'preserve external bytes',
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-orphan-type',
        payload: {
          version: 1,
          title: 'Structure',
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'pdf',
                position: { x: 0, y: 0 },
                data: { src: 'document.pdf' },
              },
            ],
            edges: [],
          },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'NODE_CONTENT_CONFLICT',
        nodeId: 'n1',
      });
      expect(store.read()).toMatchObject({
        version: 1,
        state: { nodes: [] },
      });
      expect(store.readNode('n1')).toMatchObject({
        type: 'note',
        content: 'preserve external bytes',
      });
      expect(store.readDeltaLogSince(0)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('attaches a matching orphan without publishing a node rewrite', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-orphan-attach', { nodes: [], edges: [] });
      const store = getCanvasStore('struct-orphan-attach');
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'External orphan',
        content: 'canonical orphan body',
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-orphan-attach',
        payload: {
          version: 1,
          title: 'Structure',
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 0, y: 0 },
                data: { label: 'Stale client', content: 'stale client body' },
              },
            ],
            edges: [],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        version: 2,
        commit: { nodeChanges: [] },
      });
      expect(store.readNode('n1')).toMatchObject({
        type: 'note',
        label: 'External orphan',
        content: 'canonical orphan body',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a matching orphan that is externally rewritten before attachment', async () => {
    const app = await buildApp();
    const store = getCanvasStore('struct-orphan-race');
    seedStructure('struct-orphan-race', { nodes: [], edges: [] });
    store.writeNode('n1', {
      nodeId: 'n1',
      type: 'note',
      label: 'External orphan',
      content: 'original orphan body',
    });

    const structured = getStructuredStore();
    const realSpace = structured.space.bind(structured);
    let releaseSnapshot: (() => void) | undefined;
    let markSnapshotRead: (() => void) | undefined;
    const snapshotRead = new Promise<void>((resolve) => {
      markSnapshotRead = resolve;
    });
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let paused = false;
    const spaceSpy = vi
      .spyOn(structured, 'space')
      .mockImplementation((canvasId) => {
        const handle = realSpace(canvasId);
        if (canvasId !== 'struct-orphan-race') return handle;
        return {
          ...handle,
          nodes: {
            read: async (nodeId) => {
              const snapshot = await handle.nodes.read(nodeId);
              if (!paused && nodeId === 'n1') {
                paused = true;
                markSnapshotRead?.();
                await snapshotGate;
              }
              return snapshot;
            },
            readMany: (nodeIds) => handle.nodes.readMany(nodeIds),
          },
        };
      });

    try {
      const pendingResponse = app.inject({
        method: 'PUT',
        url: '/canvas/struct-orphan-race',
        payload: {
          version: 1,
          title: 'Structure',
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 0, y: 0 },
                data: { label: 'Client note', content: 'client body' },
              },
            ],
            edges: [],
          },
        },
      });

      await snapshotRead;
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'pdf',
        label: 'External orphan',
        content: 'externally replaced body',
      });
      releaseSnapshot?.();

      const response = await pendingResponse;
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'NODE_CONTENT_CONFLICT',
        nodeId: 'n1',
      });
      expect(store.read()).toMatchObject({
        version: 1,
        state: { nodes: [] },
      });
      expect(store.readNode('n1')).toMatchObject({
        type: 'pdf',
        content: 'externally replaced body',
      });
      expect(store.readDeltaLogSince(0)).toEqual([]);
    } finally {
      releaseSnapshot?.();
      spaceSpy.mockRestore();
      await app.close();
    }
  });

  it('rebases a structure save across node-only versions without clobbering content', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-rebase', {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      });
      getCanvasStore('struct-rebase').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'v1',
      });

      const loaded = await app.inject({
        method: 'GET',
        url: '/canvas/struct-rebase',
      });
      const baseline = loaded.json<{
        version: number;
        structureRevision: string;
      }>();
      const content = await putContent(app, 'struct-rebase', 'n1', {
        nodeType: 'note',
        content: 'v2',
        expectRev: nodeRevisionOf({ content: 'v1' }),
      });
      expect(content.statusCode).toBe(200);

      const structure = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-rebase',
        payload: {
          version: baseline.version,
          expectStructureRevision: baseline.structureRevision,
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 80, y: 40 },
                data: { content: 'stale-spoof', label: 'stale-spoof' },
              },
            ],
            edges: [],
          },
        },
      });

      expect(structure.statusCode).toBe(200);
      expect(structure.json<{ version: number }>().version).toBe(3);
      expect(getCanvasStore('struct-rebase').readNode('n1')?.content).toBe(
        'v2',
      );
      expect(getCanvasStore('struct-rebase').read()).toMatchObject({
        version: 3,
        state: { nodes: [{ position: { x: 80, y: 40 }, data: {} }] },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a stale structural baseline after a competing topology change', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-conflict', { nodes: [], edges: [] });
      const loaded = await app.inject({
        method: 'GET',
        url: '/canvas/struct-conflict',
      });
      const baseline = loaded.json<{
        version: number;
        structureRevision: string;
      }>();

      const first = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-conflict',
        payload: {
          version: baseline.version,
          expectStructureRevision: baseline.structureRevision,
          state: {
            nodes: [
              {
                id: 'frame-1',
                type: 'frame',
                position: { x: 0, y: 0 },
                data: {},
              },
            ],
            edges: [],
          },
        },
      });
      expect(first.statusCode).toBe(200);

      const stale = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-conflict',
        payload: {
          version: baseline.version,
          expectStructureRevision: baseline.structureRevision,
          state: { nodes: [], edges: [] },
        },
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        code: 'CANVAS_VERSION_CONFLICT',
        serverVersion: 2,
      });
      expect(
        getCanvasStore('struct-conflict').read()?.state.nodes,
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('deletes a removed topology node and sidecar in the same PUT commit', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-delete', {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      });
      getCanvasStore('struct-delete').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Delete me',
        content: 'body',
      });

      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-delete',
        payload: { version: 1, state: { nodes: [], edges: [] } },
      });

      expect(response.statusCode).toBe(200);
      expect(getCanvasStore('struct-delete').read()?.state.nodes).toEqual([]);
      expect(getCanvasStore('struct-delete').readNode('n1')).toBeNull();
      expect(
        getCanvasStore('struct-delete').readDeltaLogSince(1)[0]?.commit,
      ).toMatchObject({
        nodeChanges: [{ kind: 'delete', nodeId: 'n1' }],
      });
    } finally {
      await app.close();
    }
  });

  it('moves sidecar ownership atomically when an existing node changes type', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-type', {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      });
      getCanvasStore('struct-type').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Old note',
        content: 'old body',
      });

      const toReference = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-type',
        payload: {
          version: 1,
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'shape',
                position: { x: 0, y: 0 },
                data: {},
              },
            ],
            edges: [],
          },
        },
      });
      expect(toReference.statusCode).toBe(200);
      expect(getCanvasStore('struct-type').readNode('n1')).toBeNull();

      const backToNote = await app.inject({
        method: 'PUT',
        url: '/canvas/struct-type',
        payload: {
          version: 2,
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 0, y: 0 },
                data: { label: 'New note', content: 'new body' },
              },
            ],
            edges: [],
          },
        },
      });
      expect(backToNote.statusCode).toBe(200);
      expect(getCanvasStore('struct-type').readNode('n1')).toMatchObject({
        type: 'note',
        label: 'New note',
        content: 'new body',
      });
      expect(getCanvasStore('struct-type').read()?.version).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('updates canonical sidecar type for markdown-backed transitions', async () => {
    const app = await buildApp();
    try {
      seedStructure('struct-md-type', {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {},
          },
        ],
        edges: [],
      });
      getCanvasStore('struct-md-type').writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Keep label',
        content: 'keep body',
      });

      for (const [version, type] of [
        [1, 'text'],
        [2, 'note'],
      ] as const) {
        const response = await app.inject({
          method: 'PUT',
          url: '/canvas/struct-md-type',
          payload: {
            version,
            state: {
              nodes: [
                {
                  id: 'n1',
                  type,
                  position: { x: 0, y: 0 },
                  data: { content: 'untrusted structure body' },
                },
              ],
              edges: [],
            },
          },
        });
        expect(response.statusCode).toBe(200);
        expect(getCanvasStore('struct-md-type').readNode('n1')).toMatchObject({
          type,
          label: 'Keep label',
          content: 'keep body',
        });
      }
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
      // Surface a recoverable conflict so a dirty client never mistakes a
      // suppressed write for durable success.
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
      // No sidecar was resurrected on disk.
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
      expect(after.statusCode).toBe(409);
      expect(after.json<{ code: string }>().code).toBe('NODE_CONTENT_CONFLICT');
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

  it('treats preprocessing that arrives after aggregate deletion as superseded', async () => {
    const app = await buildApp();
    try {
      const store = getCanvasStore('preprocess-after-delete');
      store.write({
        canvasId: 'preprocess-after-delete',
        title: null,
        version: 2,
        state: { nodes: [], edges: [] },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/canvas/preprocess-after-delete/nodes/deleted/preprocess',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'note',
          trigger: 'node_updated',
          snapshot: { content: 'late result' },
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ nodeId: 'deleted', success: true });
      expect(store.readNode('deleted')).toBeNull();
      expect(store.read()?.version).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('returns no stale projection when preprocessing targets an older node type', async () => {
    const app = await buildApp();
    try {
      seedNodeWithoutSidecar('preprocess-after-type-change', 'n1', 'text');
      const store = getCanvasStore('preprocess-after-type-change');
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'text',
        label: 'Current text',
        content: 'current body',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/canvas/preprocess-after-type-change/nodes/n1/preprocess',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'note',
          trigger: 'node_updated',
          snapshot: { content: '# Stale label' },
          options: { allowPersistence: false, allowLLM: false },
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ nodeId: 'n1', success: true });
      expect(store.readNode('n1')).toMatchObject({
        type: 'text',
        label: 'Current text',
        content: 'current body',
      });
      expect(store.read()?.version).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('keeps the route preflight baseline across dispatcher startup', async () => {
    const app = await buildApp();
    const dispatcher = getPreprocessDispatcher();
    const originalPreprocess = dispatcher.preprocess.bind(dispatcher);
    let releaseDispatcher: (() => void) | undefined;
    let enterDispatcher: (() => void) | undefined;
    const dispatcherEntered = new Promise<void>((resolve) => {
      enterDispatcher = resolve;
    });
    const dispatcherGate = new Promise<void>((resolve) => {
      releaseDispatcher = resolve;
    });
    let capturedBaseline: Parameters<typeof dispatcher.preprocess>[1];
    const preprocessSpy = vi
      .spyOn(dispatcher, 'preprocess')
      .mockImplementationOnce(async (request, baseline) => {
        capturedBaseline = baseline;
        enterDispatcher?.();
        await dispatcherGate;
        return originalPreprocess(request, baseline);
      });

    try {
      seedCanvas('preprocess-route-aba', 'n1', 'Original note');
      const store = getCanvasStore('preprocess-route-aba');
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Original note',
        content: 'original body',
      });

      const pendingResponse = app.inject({
        method: 'POST',
        url: '/canvas/preprocess-route-aba/nodes/n1/preprocess',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          nodeType: 'note',
          trigger: 'node_updated',
          snapshot: { content: '# Stale projection\nold body' },
          options: { allowPersistence: false, allowLLM: false },
        }),
      });

      await dispatcherEntered;
      expect(capturedBaseline).toMatchObject({
        topologyType: 'note',
        spaceVersion: 1,
        nodeRecordRevision: expect.any(String),
      });

      const before = store.read();
      if (!before) throw new Error('seed Space disappeared');
      store.write({ ...before, version: 2, updatedAt: Date.now() });
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Replacement note',
        content: 'replacement body',
      });

      releaseDispatcher?.();
      const response = await pendingResponse;

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ nodeId: 'n1', success: true });
      expect(store.read()).toMatchObject({ version: 2 });
      expect(store.readNode('n1')).toMatchObject({
        type: 'note',
        label: 'Replacement note',
        content: 'replacement body',
      });
    } finally {
      releaseDispatcher?.();
      preprocessSpy.mockRestore();
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
      scope: () => scope,
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
