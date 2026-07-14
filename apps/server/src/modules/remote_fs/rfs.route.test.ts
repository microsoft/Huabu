/**
 * Tests for the RFS route plugin (`/api/rfs/:canvasId/*`).
 *
 * Exercised via Fastify `inject()` so the catch-all body parser, wildcard
 * path routing, upload/download roundtrip, collision handling, and the
 * `/skill`-hint error envelope are covered end-to-end.
 *
 * Auth is applied by the global preHandler in `app.ts`, not by the route
 * plugin, so injecting the plugin directly needs no Bearer token.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import rfsRoutes from './rfs.route.js';
import { getCanvasStore } from '../storage/index.js';
import { toSafeFilename } from '../storage/naming.js';
import { setWorkspacePath } from '../workspace.js';

let tmp: string;

async function buildApp() {
  const app = fastify();
  await app.register(rfsRoutes, { prefix: '/rfs' });
  await app.ready();
  return app;
}

/**
 * Seed a note node (canvas.json entry + `nodes/<safeLabel>.md` body) and
 * return its download path. Re-calling with the same id/label overwrites the
 * body (canvas.json strips content, so the body only lives in the sidecar).
 */
function seedNote(
  canvasId: string,
  id: string,
  label: string,
  content: string,
): string {
  const store = getCanvasStore(canvasId);
  store.write({
    canvasId,
    title: null,
    version: 1,
    state: {
      nodes: [{ id, type: 'note', position: { x: 0, y: 0 }, data: { label } }],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode(id, { nodeId: id, type: 'note', label, content });
  return `nodes/${toSafeFilename(label, id)}.md`;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sediment-rfs-'));
  setWorkspacePath(tmp);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/rfs/:canvasId/skill', () => {
  it('returns the bundled access guide as markdown', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/rfs/c1/skill' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.body).toMatch(/Accessing this Huabu Space/i);
    } finally {
      await app.close();
    }
  });
});

describe('POST/GET/DELETE /api/rfs/:canvasId/upload', () => {
  it('roundtrips an upload then a download', async () => {
    const app = await buildApp();
    try {
      const up = await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/note.md',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello world',
      });
      expect(up.statusCode).toBe(201);
      expect(up.json<{ path: string; size: number }>()).toEqual({
        path: 'upload/note.md',
        size: 11,
      });

      const down = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/upload/note.md',
      });
      expect(down.statusCode).toBe(200);
      expect(down.body).toBe('hello world');
    } finally {
      await app.close();
    }
  });

  it('rejects a colliding upload with 409 and a /skill hint', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/dup.md',
        payload: 'a',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/dup.md',
        payload: 'b',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ message: string }>().message).toMatch(/\/skill/);
    } finally {
      await app.close();
    }
  });

  it('deletes a staged upload', async () => {
    const app = await buildApp();
    try {
      await app.inject({
        method: 'POST',
        url: '/rfs/c1/upload/gone.md',
        payload: 'x',
      });
      const del = await app.inject({
        method: 'DELETE',
        url: '/rfs/c1/upload/gone.md',
      });
      expect(del.statusCode).toBe(204);
      const after = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/upload/gone.md',
      });
      expect(after.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/rfs/:canvasId/download', () => {
  it('404s a missing file with a runnable /skill recovery command', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/nodes/missing.md',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(/curl .*\/skill/);
    } finally {
      await app.close();
    }
  });

  it('refuses reads of private bookkeeping dirs', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/rfs/c1/download/.memory/state.json',
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe('node download revision (ETag / conditional GET)', () => {
  it('serves an ETag and 304s a matching If-None-Match', async () => {
    const app = await buildApp();
    try {
      const file = seedNote('c1', 'node-1', 'Alpha', 'hello body');

      const res = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      expect(res.statusCode).toBe(200);
      const etag = res.headers['etag'] as string;
      expect(etag).toMatch(/^".+"$/);

      // Same content → 304, empty body.
      const notModified = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
        headers: { 'if-none-match': etag },
      });
      expect(notModified.statusCode).toBe(304);
      expect(notModified.body).toBe('');
    } finally {
      await app.close();
    }
  });

  it('changes the ETag when the authored body changes', async () => {
    const app = await buildApp();
    try {
      const file = seedNote('c1', 'node-1', 'Alpha', 'first body');
      const first = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      const etag1 = first.headers['etag'] as string;

      seedNote('c1', 'node-1', 'Alpha', 'second body');
      const second = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
        headers: { 'if-none-match': etag1 },
      });
      // Body changed → the stale If-None-Match no longer matches → 200.
      expect(second.statusCode).toBe(200);
      expect(second.headers['etag']).not.toBe(etag1);
    } finally {
      await app.close();
    }
  });
});
