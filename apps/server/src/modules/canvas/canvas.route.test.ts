/**
 * Route tests for the Canvas behavioural event log.
 *
 * Written for the Phase-2 consumer slice (docs/proposals/multi-backend-storage.md
 * §12.2.8): `GET /:canvasId/events` is the one read migrated from the
 * compatibility facade onto `logs.readEvents`. The handler had no test, so
 * these assert the payload it produces rather than the data source it uses —
 * which is what makes them meaningful on both sides of the swap.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import canvasRoutes from './canvas.route.js';
import { createCanvas, getCanvasStore, resetStorageCache } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { RecentAction } from '@sediment/shared';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

function action(nodeId: string): RecentAction {
  return {
    action: 'node_selected',
    node: { id: nodeId, type: 'note', label: nodeId },
  };
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
  tmp = mkdtempSync(join(tmpdir(), 'sediment-canvas-events-'));
  setWorkspacePath(tmp);
  resetStorageCache();
});

afterEach(() => {
  resetStorageCache();
  rmSync(tmp, { recursive: true, force: true });
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
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([4, 5]);
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
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([4, 5]);
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
      expect(res.json().events.map((e: { ts: number }) => e.ts)).toEqual([4, 5]);
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
