/**
 * Route tests for the Canvas behavioural event log.
 *
 * Written for the Phase-2 consumer slice (docs/proposals/multi-backend-storage.md
 * §12.2.8): `GET /:canvasId/events` is the one read migrated from the
 * compatibility facade onto `events.read`. The handler had no test, so
 * these assert the payload it produces rather than the data source it uses —
 * which is what makes them meaningful on both sides of the swap.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { extractCanvasChanges } from '@sediment/shared/canvas-engine';

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
} from '../storage/index.js';
import { withSpaceDirHandlesReleased } from '../workspace/disk/space-dir-handles.js';
import { setWorkspacePath } from '../workspace.js';

import type * as StorageModule from '../storage/index.js';
import type * as SpaceDirHandlesModule from '../workspace/disk/space-dir-handles.js';
import type { RecentAction } from '@sediment/shared';

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
  const boundary = '----sediment-canvas-route-test';
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
  tmp = mkdtempSync(join(tmpdir(), 'sediment-canvas-events-'));
  setWorkspacePath(tmp);
  resetStorageCache();
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PUT /api/canvas/:canvasId lifecycle', () => {
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
    const history = getStructuredStore().space('c1');
    await history.events.append([{ payload: action('n1'), ts: 1 }]);
    await history.deltas.append({
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
        'round-trip.sediment.zip',
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
