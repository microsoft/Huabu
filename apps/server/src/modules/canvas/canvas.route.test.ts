// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/** Route coverage for repository-backed storage consumers and lifecycle. */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractCanvasChanges } from '@huabu/shared/canvas-engine';

vi.mock('../storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    getStructuredStore: vi.fn(() => actual.getStructuredStore()),
  };
});

vi.mock('../workspace/disk/space-dir-handles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SpaceDirHandlesModule>();
  return {
    ...actual,
    withSpaceDirHandlesReleased: vi.fn(actual.withSpaceDirHandlesReleased),
  };
});

import canvasRoutes from './canvas.route.js';
import {
  createCanvas,
  canvasBlobs,
  deleteCanvas,
  getCanvasStore,
  getStructuredStore,
  resetStorageCache,
  withCanvasMutex,
} from '../storage/index.js';
import { changesPath } from '../workspace/disk/paths.js';
import { withSpaceDirHandlesReleased } from '../workspace/disk/space-dir-handles.js';
import { setWorkspacePath } from '../workspace.js';

import type * as StorageModule from '../storage/index.js';
import type * as SpaceDirHandlesModule from '../workspace/disk/space-dir-handles.js';
import type { RecentAction } from '@huabu/shared';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(multipart);
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

function multipartBody(
  filename: string,
  contentType: string,
  body: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----huabu-canvas-route-test';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

function action(nodeId: string): RecentAction {
  return {
    action: 'node_selected',
    node: { id: nodeId, type: 'note', label: nodeId },
  };
}

function change(nodeId: string) {
  const [record] = extractCanvasChanges([
    {
      type: 'INSERT_NODE' as const,
      node: {
        id: nodeId,
        type: 'note' as const,
        position: { x: 0, y: 0 },
        data: { label: nodeId, content: `body-${nodeId}` },
      },
    },
  ]);
  return record;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Seed `count` events at ts 1..count. */
function seedEvents(canvasId: string, count: number): void {
  getCanvasStore(canvasId).appendEvents(
    Array.from({ length: count }, (_, i) => ({
      payload: action(`n${i + 1}`),
      ts: i + 1,
    })),
  );
}

beforeEach(() => {
  vi.mocked(getStructuredStore).mockClear();
  vi.mocked(withSpaceDirHandlesReleased).mockImplementation(
    async (_canvasId, operation) => operation(),
  );
  tmp = mkdtempSync(join(tmpdir(), 'huabu-canvas-events-'));
  setWorkspacePath(tmp);
  resetStorageCache();
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PUT /api/canvas/:canvasId lifecycle', () => {
  it('does not recreate a Space deleted after the initial read', async () => {
    await createCanvas('c1', 'Original');
    const paused = deferred();
    const release = deferred();
    const structured = getStructuredStore();
    const realSpace = structured.space.bind(structured);
    vi.mocked(getStructuredStore).mockImplementationOnce(
      () =>
        ({
          ...structured,
          space: (canvasId: string) => {
            const handle = realSpace(canvasId);
            if (canvasId !== 'c1') return handle;
            return {
              ...handle,
              commit: async (...args: Parameters<typeof handle.commit>) => {
                paused.resolve();
                await release.promise;
                return handle.commit(...args);
              },
            };
          },
        }) as ReturnType<typeof getStructuredStore>,
    );

    const app = await buildApp();
    try {
      const updating = app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          title: 'Renamed before delete',
          state: { nodes: [], edges: [] },
        },
      });
      await paused.promise;
      await expect(deleteCanvas('c1')).resolves.toBe(true);
      release.resolve();

      const response = await updating;
      expect(response.statusCode).toBe(404);
      expect(getCanvasStore('c1').read()).toBeNull();
    } finally {
      release.resolve();
      await app.close();
    }
  });
});

describe('GET /api/canvas', () => {
  it('lists through the catalogue and sorts a copy by updatedAt', async () => {
    const source = [
      {
        canvasId: 'older',
        title: 'Older',
        nodeCount: 1,
        createdAt: 1,
        updatedAt: 10,
      },
      {
        canvasId: 'newer',
        title: 'Newer',
        nodeCount: 2,
        createdAt: 2,
        updatedAt: 20,
      },
    ];
    const list = vi.fn().mockResolvedValue(source);
    const catalog = vi.fn(() => ({
      list,
      worldId: vi.fn(),
    }));
    vi.mocked(getStructuredStore).mockImplementationOnce(
      () => ({ catalog }) as unknown as ReturnType<typeof getStructuredStore>,
    );

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/canvas' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ canvases: [source[1], source[0]] });
      expect(source.map((row) => row.canvasId)).toEqual(['older', 'newer']);
      expect(catalog).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('POST/DELETE /api/canvas lifecycle outcomes', () => {
  it('returns the effective de-duplicated title from structured creation', async () => {
    const app = await buildApp();
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/canvas',
        payload: { title: 'Shared title' },
      });
      const second = await app.inject({
        method: 'POST',
        url: '/canvas',
        payload: { title: 'Shared title' },
      });

      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ title: 'Shared title' });
      expect(second.statusCode).toBe(201);
      expect(second.json()).toMatchObject({ title: 'Shared title (2)' });
    } finally {
      await app.close();
    }
  });

  it('maps deleted, missing, and World-forbidden lifecycle results', async () => {
    const created = await createCanvas('delete-route', 'Delete route');
    if (!created) throw new Error('Could not seed route lifecycle Space');
    const worldCanvasId = await getStructuredStore().catalog().worldId();
    const app = await buildApp();
    try {
      const deleted = await app.inject({
        method: 'DELETE',
        url: '/canvas/delete-route',
      });
      const missing = await app.inject({
        method: 'DELETE',
        url: '/canvas/delete-route',
      });
      const world = await app.inject({
        method: 'DELETE',
        url: `/canvas/${worldCanvasId}`,
      });

      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual({ success: true });
      expect(missing.statusCode).toBe(404);
      expect(world.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/canvas/:canvasId/events', () => {
  it('returns the events in chronological order', async () => {
    await createCanvas('c1', 'Canvas One');
    seedEvents('c1', 3);

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/canvas/c1/events' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        events: [
          { ts: 1, payload: action('n1') },
          { ts: 2, payload: action('n2') },
          { ts: 3, payload: action('n3') },
        ],
      });
      expect(getStructuredStore).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('returns an empty list for a Space with no events', async () => {
    await createCanvas('c1', 'Canvas One');

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/canvas/c1/events' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ events: [] });
    } finally {
      await app.close();
    }
  });

  it('tails to the most recent `limit` events', async () => {
    await createCanvas('c1', 'Canvas One');
    seedEvents('c1', 5);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/events?limit=2',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([
        4, 5,
      ]);
    } finally {
      await app.close();
    }
  });

  it('drops events older than `since`, within the limit window', async () => {
    await createCanvas('c1', 'Canvas One');
    seedEvents('c1', 5);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/events?since=4',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([
        4, 5,
      ]);
    } finally {
      await app.close();
    }
  });

  it('applies `since` to the tail the limit already selected', async () => {
    await createCanvas('c1', 'Canvas One');
    seedEvents('c1', 5);

    const app = await buildApp();
    try {
      // `limit` tails first (4, 5), then `since` filters that window — so an
      // older `since` cannot reach back past the limit.
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/events?limit=2&since=1',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([
        4, 5,
      ]);
    } finally {
      await app.close();
    }
  });

  it('404s for a Space that does not exist', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/missing/events',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ message: 'Canvas not found' });
    } finally {
      await app.close();
    }
  });

  it('does not report a corrupt Space record as missing', async () => {
    await createCanvas('c1', 'Canvas One');
    writeFileSync(join(tmp, 'Canvas One', 'space.json'), '{broken', 'utf8');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/events',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).not.toEqual({ message: 'Canvas not found' });
    } finally {
      await app.close();
    }
  });

  it('400s on an invalid query', async () => {
    await createCanvas('c1', 'Canvas One');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/events?limit=not-a-number',
      });

      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/canvas/:canvasId/threads/:threadId/changes', () => {
  it('reads change records through one structured Space handle', async () => {
    const expected = [change('n1')];
    const readRecord = vi.fn().mockResolvedValue({ canvasId: 'c1' });
    const readChanges = vi.fn().mockResolvedValue(expected);
    const space = vi.fn(() => ({
      record: { read: readRecord },
      changes: { read: readChanges },
    }));
    vi.mocked(getStructuredStore).mockImplementationOnce(
      () => ({ space }) as unknown as ReturnType<typeof getStructuredStore>,
    );

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/threads/thread-1/changes',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ changes: expected });
      expect(getStructuredStore).toHaveBeenCalledTimes(1);
      expect(space).toHaveBeenCalledTimes(1);
      expect(space).toHaveBeenCalledWith('c1');
      expect(readRecord).toHaveBeenCalledTimes(1);
      expect(readChanges).toHaveBeenCalledWith('thread-1');
    } finally {
      await app.close();
    }
  });

  it('returns an empty list when the thread has no changes', async () => {
    await createCanvas('c1', 'Canvas One');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/threads/thread-1/changes',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ changes: [] });
    } finally {
      await app.close();
    }
  });

  it('404s for a Space that does not exist', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/missing/threads/thread-1/changes',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ message: 'Canvas not found' });
    } finally {
      await app.close();
    }
  });

  it('does not report a corrupt Space record as missing', async () => {
    await createCanvas('c1', 'Canvas One');
    writeFileSync(join(tmp, 'Canvas One', 'space.json'), '{broken', 'utf8');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/threads/thread-1/changes',
      });

      expect(res.statusCode).toBe(500);
      expect(res.json()).not.toEqual({ message: 'Canvas not found' });
    } finally {
      await app.close();
    }
  });

  it('rejects a corrupt change-record array', async () => {
    await createCanvas('c1', 'Canvas One');
    await getStructuredStore()
      .space('c1')
      .changes.append('thread-1', [change('n1')]);
    writeFileSync(changesPath('c1', 'thread-1'), '{}', 'utf8');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/canvas/c1/threads/thread-1/changes',
      });

      expect(res.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
});

describe('DELETE /api/canvas/:canvasId/threads/:threadId/changes/:changeId', () => {
  it('holds the Space mutex across the existence check and removal', async () => {
    const readStarted = deferred();
    const releaseRead = deferred();
    const readRecord = vi.fn(async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return { canvasId: 'c1' };
    });
    const removedRecord = change('n1');
    const removeChange = vi.fn().mockResolvedValue(removedRecord);
    const space = vi.fn(() => ({
      record: { read: readRecord },
      changes: { remove: removeChange },
    }));
    vi.mocked(getStructuredStore).mockImplementationOnce(
      () => ({ space }) as unknown as ReturnType<typeof getStructuredStore>,
    );

    const app = await buildApp();
    try {
      const deleting = Promise.resolve(
        app.inject({
          method: 'DELETE',
          url: `/canvas/c1/threads/thread-1/changes/${removedRecord.id}`,
        }),
      );
      await readStarted.promise;

      let competingMutationStarted = false;
      const competing = withCanvasMutex('c1', async () => {
        competingMutationStarted = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(competingMutationStarted).toBe(false);
      expect(removeChange).not.toHaveBeenCalled();

      releaseRead.resolve();
      const [response] = await Promise.all([deleting, competing]);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ removed: true });
      expect(removeChange).toHaveBeenCalledWith('thread-1', removedRecord.id);
      expect(competingMutationStarted).toBe(true);
    } finally {
      releaseRead.resolve();
      await app.close();
    }
  });
});

describe('Space export/import persistence', () => {
  it('round-trips topology, sidecars, history, and blobs after a cache reopen', async () => {
    await createCanvas('c1', 'Round Trip');
    const store = getCanvasStore('c1');
    const current = store.read()!;
    store.write({
      ...current,
      version: 1,
      state: {
        nodes: [
          {
            id: 'n1',
            type: 'note',
            position: { x: 0, y: 0 },
            data: {
              label: 'Note',
              src: '/api/canvas/c1/artifact/asset.bin',
            },
          },
        ],
        edges: [],
      },
      updatedAt: current.updatedAt + 1,
    });
    expect(
      store.writeNode('n1', {
        nodeId: 'n1',
        type: 'note',
        label: 'Note',
        content: 'persisted body',
      }),
    ).toMatchObject({ ok: true });
    const history = getStructuredStore().space('c1');
    await history.events.append([{ payload: action('n1'), ts: 1 }]);
    store.appendDeltaLogEntry({
      version: 1,
      ts: 2,
      commands: [],
      deltas: [],
      originator: { source: 'agent' },
    });
    await history.intents.upsert({
      id: 'intent-1',
      timestamp: 3,
      contextSummary: 'Persist this intent',
      candidates: [],
      outcome: {
        type: 'selected',
        chosenIndex: 0,
        chosenLabel: 'Keep it',
      },
    });
    const [change] = extractCanvasChanges([
      {
        type: 'INSERT_NODE',
        node: {
          id: 'review-node',
          type: 'note',
          position: { x: 0, y: 0 },
          data: { label: 'Review', content: 'Persist this change' },
        },
      },
    ]);
    const storedChanges = await history.changes.append('thread-export', [
      change,
    ]);
    const blob = Buffer.from([0, 1, 2, 3, 255]);
    await canvasBlobs('c1').put('asset.bin', blob);

    const app = await buildApp();
    try {
      const exported = await app.inject({
        method: 'GET',
        url: '/canvas/c1/export',
      });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers['content-type']).toContain('application/zip');

      const upload = multipartBody(
        'round-trip.huabu.zip',
        'application/zip',
        exported.rawPayload,
      );
      const imported = await app.inject({
        method: 'POST',
        url: '/canvas/import',
        payload: upload.payload,
        headers: upload.headers,
      });
      expect(imported.statusCode).toBe(200);
      const importedId = (imported.json() as { canvasId: string }).canvasId;
      expect(importedId).not.toBe('c1');

      // Discard every live adapter/index so the assertions exercise the
      // imported bytes through a genuinely fresh handle.
      resetStorageCache();
      const reopened = getCanvasStore(importedId);
      const record = reopened.read();
      expect(record).toMatchObject({
        canvasId: importedId,
        title: 'Round Trip (2)',
        version: 1,
      });
      expect(JSON.stringify(record?.state)).toContain(
        `/api/canvas/${importedId}/artifact/asset.bin`,
      );
      expect(reopened.readNode('n1')?.content).toBe('persisted body');
      const reopenedHistory = getStructuredStore().space(importedId);
      expect(
        (await reopenedHistory.events.read()).map((event) => event.ts),
      ).toEqual([1]);
      expect(
        (await reopenedHistory.deltas.readSince(0)).map(
          (entry) => entry.version,
        ),
      ).toEqual([1]);
      expect(
        (await reopenedHistory.intents.read()).map((episode) => episode.id),
      ).toEqual(['intent-1']);
      expect(await reopenedHistory.changes.read('thread-export')).toEqual(
        storedChanges,
      );
      expect(await canvasBlobs(importedId).read('asset.bin')).toEqual(blob);
    } finally {
      await app.close();
    }
  });
});
