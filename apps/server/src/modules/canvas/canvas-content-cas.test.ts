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

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import canvasRoutes from './canvas.route.js';
import {
  getCanvasStore,
  getStorage,
  setStorageForTesting,
} from '../storage/index.js';
import { nodesDir } from '../storage/paths.js';
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
