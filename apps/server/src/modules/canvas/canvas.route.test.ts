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

// Mocked at the module the Disk repository imports, not at the facade: these
// cases force a Space-directory rename to fail, which is Disk behavior, and a
// facade mock would not intercept the adapter's own import.
vi.mock(
  '../storage/backends/disk/space-dir-handles.js',
  async (importOriginal) => {
    const actual = await importOriginal<typeof SpaceDirHandlesModule>();
    return {
      ...actual,
      withSpaceDirHandlesReleased: vi.fn(actual.withSpaceDirHandlesReleased),
    };
  },
);

import canvasRoutes from './canvas.route.js';
import { withSpaceDirHandlesReleased } from '../storage/backends/disk/space-dir-handles.js';
import { createCanvas, deleteCanvas } from '../storage/compatibility/canvas.js';
import {
  space,
  getCanvasStore,
  getStructuredStore,
  resetStorageCache,
} from '../storage/index.js';
import { changesPath } from '../storage/paths.js';
import { setWorkspacePath } from '../workspace.js';

import type * as SpaceDirHandlesModule from '../storage/backends/disk/space-dir-handles.js';
import type * as StorageModule from '../storage/index.js';
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

describe('POST /api/canvas lifecycle', () => {
  it('allocates concurrent default titles without skipping a suffix', async () => {
    const app = await buildApp();
    try {
      const [first, second] = await Promise.all([
        app.inject({ method: 'POST', url: '/canvas', payload: {} }),
        app.inject({ method: 'POST', url: '/canvas', payload: {} }),
      ]);

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect([first.json().title, second.json().title].sort()).toEqual([
        'Untitled',
        'Untitled (1)',
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('PUT /api/canvas/:canvasId lifecycle', () => {
  it('preserves the legacy structural response, version bump, and no-delta behavior', async () => {
    createCanvas('c1', 'Original');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          state: {
            nodes: [
              {
                id: 'n1',
                type: 'note',
                position: { x: 0, y: 0 },
                data: { label: 'Note', content: 'must stay out of space.json' },
              },
            ],
            edges: [],
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ canvasId: 'c1', version: 1 });
      expect(getCanvasStore('c1').read()).toMatchObject({
        version: 1,
        state: {
          nodes: [
            expect.objectContaining({
              id: 'n1',
              data: { label: 'Note' },
            }),
          ],
          edges: [],
        },
      });
      expect(getCanvasStore('c1').readDeltaLogSince(0)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('keeps the legacy implicit-create path for an initially absent Space', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/implicit',
        payload: { version: 0, state: { nodes: [], edges: [] } },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ canvasId: 'implicit', version: 1 });
      expect(getCanvasStore('implicit').read()).toMatchObject({
        canvasId: 'implicit',
        version: 1,
        state: { nodes: [], edges: [] },
      });
    } finally {
      await app.close();
    }
  });

  it('keeps title collision as a 409 without applying the record write', async () => {
    createCanvas('c1', 'Original');
    createCanvas('c2', 'Taken/A');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          title: 'Taken:A',
          state: { nodes: [], edges: [] },
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        code: 'CANVAS_TITLE_CONFLICT',
        conflictWith: 'Taken/A',
      });
      expect(getCanvasStore('c1').read()).toMatchObject({
        title: 'Original',
        version: 0,
      });
    } finally {
      await app.close();
    }
  });

  it('renames only when the request explicitly supplies a new title', async () => {
    createCanvas('c1', 'Original');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          title: 'Explicit rename',
          state: { nodes: [], edges: [] },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(getCanvasStore('c1').read()).toMatchObject({
        title: 'Explicit rename',
        version: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('persists a logical rename when both titles share one safe filename', async () => {
    createCanvas('c1', 'A/B');
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          title: 'A:B',
          state: { nodes: [], edges: [] },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(getCanvasStore('c1').read()).toMatchObject({
        title: 'A:B',
        version: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('preserves an externally reconciled title when the request omits title', async () => {
    createCanvas('c1', 'Original');
    const store = getCanvasStore('c1');
    expect(store.renameSelf('Finder rename')).toMatchObject({ ok: true });
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: { version: 0, state: { nodes: [], edges: [] } },
      });

      expect(response.statusCode).toBe(200);
      expect(getCanvasStore('c1').read()).toMatchObject({
        title: 'Finder rename',
        version: 1,
      });
    } finally {
      await app.close();
    }
  });

  it('keeps filesystem rename failures behind the legacy generic 500', async () => {
    createCanvas('c1', 'Original');
    vi.mocked(withSpaceDirHandlesReleased).mockImplementationOnce(
      (async () => ({
        ok: false,
        reason: 'fs-error',
        message: 'sensitive filesystem detail',
      })) as unknown as typeof withSpaceDirHandlesReleased,
    );
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/canvas/c1',
        payload: {
          version: 0,
          title: 'Cannot rename',
          state: { nodes: [], edges: [] },
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ message: 'Failed to rename canvas' });
      expect(response.body).not.toContain('sensitive filesystem detail');
    } finally {
      await app.close();
    }
  });

  it('does not recreate a Space deleted after the initial read', async () => {
    createCanvas('c1', 'Original');
    const paused = deferred();
    const release = deferred();
    vi.mocked(withSpaceDirHandlesReleased).mockImplementationOnce(
      async (_canvasId, operation) => {
        const result = await operation();
        paused.resolve();
        await release.promise;
        return result;
      },
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
  it('lists through the Space repository and sorts a copy by updatedAt', async () => {
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
    const spaces = vi.fn(() => ({
      list,
      worldId: vi.fn(),
    }));
    vi.mocked(getStructuredStore).mockImplementationOnce(
      () => ({ spaces }) as unknown as ReturnType<typeof getStructuredStore>,
    );

    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/canvas' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ canvases: [source[1], source[0]] });
      expect(source.map((row) => row.canvasId)).toEqual(['older', 'newer']);
      expect(spaces).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/canvas/:canvasId/events', () => {
  it('returns the events in chronological order', async () => {
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');

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
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');

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
      read: readRecord,
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
    createCanvas('c1', 'Canvas One');

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
    createCanvas('c1', 'Canvas One');
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
    createCanvas('c1', 'Canvas One');
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

describe('Space export/import persistence', () => {
  it('round-trips topology, sidecars, history, and blobs after a cache reopen', async () => {
    createCanvas('c1', 'Round Trip');
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
    const seededSpace = getStructuredStore().space('c1');
    await seededSpace.events.append([{ payload: action('n1'), ts: 1 }]);
    getCanvasStore('c1').appendDeltaLogEntry({
      version: 1,
      ts: 2,
      commands: [],
      deltas: [],
      originator: { source: 'agent' },
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
    const storedChanges = await seededSpace.changes.append('thread-export', [
      change,
    ]);
    const blob = Buffer.from([0, 1, 2, 3, 255]);
    await space('c1').blobs.put('asset.bin', blob);

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
      const importedSpace = getStructuredStore().space(importedId);
      expect(
        (await importedSpace.events.read()).map((event) => event.ts),
      ).toEqual([1]);
      expect(
        getCanvasStore(importedId)
          .readDeltaLogSince(0)
          .map((entry) => entry.version),
      ).toEqual([1]);
      expect(await importedSpace.changes.read('thread-export')).toEqual(
        storedChanges,
      );
      expect(await space(importedId).blobs.read('asset.bin')).toEqual(blob);
    } finally {
      await app.close();
    }
  });
});
