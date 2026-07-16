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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentMocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  record: vi.fn(),
  get: vi.fn(),
  handleRun: vi.fn(),
}));

vi.mock('../agent/agent.service.js', () => ({
  runAgent: agentMocks.runAgent,
}));

vi.mock('../agent/agenetes/drivers.js', () => ({
  INTERNAL_DRIVER_KIND: 'internal',
  agenetes: {
    record: agentMocks.record,
    get: agentMocks.get,
  },
}));

import rfsRoutes from './rfs.route.js';
import { acquireAgentTurn } from '../agent/turn-lease.js';
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
 * Seed a note node (topology entry + `nodes/<safeLabel>.md` body) and
 * return its download path. Re-calling with the same id/label overwrites the
 * body (topology strips content, so the body only lives in the sidecar).
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
  agentMocks.runAgent.mockReset();
  agentMocks.record.mockReset();
  agentMocks.get.mockReset();
  agentMocks.handleRun.mockReset();
  agentMocks.runAgent.mockImplementation(async function* () {
    yield { type: 'done', data: { message: 'first answer' } };
    return [];
  });
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

describe('POST /api/rfs/:canvasId/agent', () => {
  it('creates a Deployment and returns its thread id before the final text', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.body).toMatch(
        /^: ok\n\n: threadId reachback-[^\n]+\n\ndata: first answer\n\n$/,
      );
      expect(agentMocks.runAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: 'operate',
          workloadType: 'Deployment',
          threadId: expect.stringMatching(/^reachback-/),
          canvasId: 'c1',
          envelope: expect.objectContaining({
            user: expect.objectContaining({ text: 'hello' }),
          }),
          context: expect.objectContaining({ messages: [] }),
        }),
      );
    } finally {
      await app.close();
    }
  });

  it('continues an existing live internal Deployment directly through its handle', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.handleRun.mockImplementation(async function* () {
      yield { type: 'done', data: { message: 'continued answer' } };
      return [];
    });
    agentMocks.get.mockReturnValue({ run: agentMocks.handleRun });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-existing',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain(': threadId reachback-existing');
      expect(res.body).toContain('data: continued answer');
      expect(agentMocks.runAgent).not.toHaveBeenCalled();
      expect(agentMocks.record).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'c1' }),
        'reachback-existing',
      );
      expect(agentMocks.handleRun).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'huabu.chat',
          content: expect.objectContaining({
            user: expect.objectContaining({ text: 'continue' }),
          }),
          rendered: [{ type: 'text', text: 'continue' }],
        }),
        expect.objectContaining({ maxIterations: 20 }),
      );

      const next = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-existing',
        },
        payload: 'continue again',
      });
      expect(next.statusCode).toBe(200);
      expect(agentMocks.handleRun).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('returns thread_not_live before opening SSE', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.get.mockReturnValue(undefined);

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-cold',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('thread_not_live');
    } finally {
      await app.close();
    }
  });

  it('rejects a non-internal Deployment', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'external', workloadType: 'Deployment' },
      state: {},
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'external-thread',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('unsupported_thread_kind');
      expect(agentMocks.get).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns thread_busy before opening SSE', async () => {
    agentMocks.record.mockReturnValue({
      spec: { kind: 'internal', workloadType: 'Deployment' },
      state: {},
    });
    agentMocks.get.mockReturnValue({ run: agentMocks.handleRun });
    const release = acquireAgentTurn('reachback-busy');

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'text/plain',
          'x-huabu-thread-id': 'reachback-busy',
        },
        payload: 'continue',
      });

      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('thread_busy');
    } finally {
      release?.();
      await app.close();
    }
  });

  it('keeps terminal errors visible in final mode', async () => {
    agentMocks.runAgent.mockImplementation(async function* () {
      yield { type: 'error', data: { error: 'model failed' } };
      return [];
    });

    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: error');
      expect(res.body).toContain('"error":"model failed"');
    } finally {
      await app.close();
    }
  });

  it('lets event-mode headers override legacy JSON options', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/rfs/c1/agent',
        headers: {
          'content-type': 'application/json',
          'x-huabu-event-mode': 'all',
        },
        payload: JSON.stringify({ prompt: 'hello', doneTextOnly: true }),
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('event: meta');
      expect(res.body).toContain('event: done');
      expect(res.body).toContain('event: end');
    } finally {
      await app.close();
    }
  });
});
