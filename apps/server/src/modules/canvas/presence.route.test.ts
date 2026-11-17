// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_PRESENCE_LIMITS } from '@huabu/shared';

import { canvasPresence } from './canvas-presence.js';
import { publishCanvasUpdate } from './canvas-sync.js';
import presenceRoutes from './presence.route.js';
import syncRoutes from './sync.route.js';
import { setRequestIdentity } from '../identity/request.js';
import { createApplicationRateLimitOptions } from '../security/rate-limit.js';

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../storage/index.js', () => ({ space: () => ({ read: mocks.read }) }));

afterEach(() => {
  canvasPresence.reset();
  vi.resetAllMocks();
});

async function buildApp(globalMax?: number) {
  const app = Fastify();
  if (globalMax !== undefined)
    await app.register(
      rateLimit,
      createApplicationRateLimitOptions({ max: globalMax }),
    );
  await app.register(presenceRoutes);
  await app.register(syncRoutes);
  app.get('/other', async () => ({ ok: true }));
  return app;
}

function post(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  payload: unknown,
) {
  return app.inject({ method: 'POST', url, payload: payload as object });
}

/** Open the sync stream and collect its `presence` events as they arrive. */
async function openStream(address: string, path: string) {
  const controller = new AbortController();
  const response = await fetch(`${address}${path}`, {
    signal: controller.signal,
  });
  if (!response.body) throw new Error('Stream has no body');
  const reader = response.body.getReader();
  const events: unknown[] = [];
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += new TextDecoder().decode(chunk.value);
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const data = /^event: presence\ndata: (.*)$/.exec(part)?.[1];
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { status: response.status, events, close: () => controller.abort() };
}

describe('presence routes', () => {
  it('accepts a report and stores it for the Space', async () => {
    const app = await buildApp();
    const response = await post(app, '/space-1/presence', {
      pageId: 'page-a',
      label: 'Chrome · macOS',
      pointer: { x: 12.5, y: -3 },
      selectedNodeIds: ['n1'],
      draggingNodeIds: [],
      editingNodeIds: ['n2'],
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    const key = '\u0000space-1';
    expect(canvasPresence.snapshot(key)).toEqual([
      {
        pageId: 'page-a',
        colorIndex: 0,
        label: 'Chrome · macOS',
        pointer: { x: 12.5, y: -3 },
        selectedNodeIds: ['n1'],
        draggingNodeIds: [],
        editingNodeIds: ['n2'],
      },
    ]);
    await app.close();
  });

  it.each([
    ['a missing page id', {}],
    ['a page id with other characters', { pageId: 'a b' }],
    [
      'a page id that is too long',
      { pageId: 'p'.repeat(CANVAS_PRESENCE_LIMITS.pageIdMaxLength + 1) },
    ],
    ['an unknown field', { pageId: 'a', position: { x: 1, y: 1 } }],
    [
      'a pointer with extra fields',
      { pageId: 'a', pointer: { x: 1, y: 1, z: 1 } },
    ],
    ['a non-numeric pointer', { pageId: 'a', pointer: { x: '1', y: 1 } }],
    ['a pointer out of range', { pageId: 'a', pointer: { x: 1e12, y: 0 } }],
    [
      'too many node ids',
      {
        pageId: 'a',
        selectedNodeIds: Array.from(
          { length: CANVAS_PRESENCE_LIMITS.maxNodeIds + 1 },
          (_, index) => `n${index}`,
        ),
      },
    ],
    [
      'a node id that is too long',
      {
        pageId: 'a',
        editingNodeIds: [
          'n'.repeat(CANVAS_PRESENCE_LIMITS.nodeIdMaxLength + 1),
        ],
      },
    ],
    [
      'a label that is too long',
      {
        pageId: 'a',
        label: 'l'.repeat(CANVAS_PRESENCE_LIMITS.labelMaxLength + 1),
      },
    ],
  ])('rejects %s with 400 and stores nothing', async (_name, payload) => {
    const app = await buildApp();
    const response = await post(app, '/space-1/presence', payload);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ message: expect.any(String) });
    expect(canvasPresence.snapshot('\u0000space-1')).toEqual([]);
    await app.close();
  });

  it('rejects an invalid Space id and an oversized body', async () => {
    const app = await buildApp();
    expect(
      (await post(app, '/bad%20id/presence', { pageId: 'a' })).statusCode,
    ).toBe(400);
    const huge = await post(app, '/space-1/presence', {
      pageId: 'a',
      label: 'x'.repeat(200 * 1024),
    });
    expect(huge.statusCode).toBe(413);
    await app.close();
  });

  it('answers 429 with a retry hint once one page reports too often', async () => {
    const app = await buildApp();
    let last = await post(app, '/space-1/presence', { pageId: 'a' });
    for (
      let index = 0;
      index < CANVAS_PRESENCE_LIMITS.maxReportsPerSecond;
      index += 1
    )
      last = await post(app, '/space-1/presence', {
        pageId: 'a',
        pointer: { x: index, y: 0 },
      });
    expect(last.statusCode).toBe(429);
    expect(last.headers['retry-after']).toBe('1');
    expect(last.json()).toMatchObject({ code: 'PRESENCE_RATE_LIMITED' });
    await app.close();
  });

  it('counts reports against their own peer budget, not the application one', async () => {
    const app = await buildApp(5);
    for (let index = 0; index < 12; index += 1) {
      const response = await post(app, '/space-1/presence', {
        pageId: `page-${index}`,
      });
      expect(response.statusCode).toBe(204);
    }
    expect((await app.inject({ url: '/other' })).statusCode).toBe(200);
    await app.close();
  });

  it('removes the page on leave and validates the leave body', async () => {
    const app = await buildApp();
    await post(app, '/space-1/presence', { pageId: 'page-a' });
    expect(
      (await post(app, '/space-1/presence/leave', { pageId: 'no such' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(app, '/space-1/presence/leave', { pageId: 'page-a' }))
        .statusCode,
    ).toBe(204);
    expect(canvasPresence.snapshot('\u0000space-1')).toEqual([]);
    await app.close();
  });
});

describe('presence on the Canvas Sync stream', () => {
  it('sends who is present on connect, relays the rest, and drops a page whose stream closes', async () => {
    mocks.read.mockResolvedValue({ version: 1 });
    const app = await buildApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const report = (body: object) =>
      fetch(`${address}/space-1/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const a = await openStream(address, '/space-1/sync/stream?pageId=page-a');
      expect(a.status).toBe(200);
      await report({
        pageId: 'page-a',
        label: 'A',
        pointer: { x: 1, y: 2 },
        selectedNodeIds: ['n1'],
      });

      const b = await openStream(address, '/space-1/sync/stream?pageId=page-b');
      await vi.waitFor(() => expect(b.events).toHaveLength(1));
      expect(b.events[0]).toEqual({
        op: 'snapshot',
        pages: [
          expect.objectContaining({
            pageId: 'page-a',
            label: 'A',
            pointer: { x: 1, y: 2 },
            selectedNodeIds: ['n1'],
          }),
        ],
      });

      await report({ pageId: 'page-a', pointer: { x: 5, y: 6 } });
      await vi.waitFor(() => expect(b.events).toHaveLength(2));
      expect(b.events[1]).toEqual({
        op: 'pointer',
        pageId: 'page-a',
        pointer: { x: 5, y: 6 },
      });
      // The author is sent an empty snapshot and never its own presence.
      expect(a.events).toEqual([{ op: 'snapshot', pages: [] }]);

      a.close();
      await vi.waitFor(() => expect(b.events).toHaveLength(3));
      expect(b.events[2]).toEqual({ op: 'leave', pageId: 'page-a' });
      b.close();
    } finally {
      await app.close();
    }
  });

  it('rejects a malformed page id before opening the stream', async () => {
    const app = await buildApp();
    const response = await app.inject({
      url: '/space-1/sync/stream?pageId=a%20b',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("presence and the caller's principal", () => {
  /**
   * The routes behind an identity layer: `x-principal` names the caller and
   * `x-access` its access to the Space (`write` by default).
   */
  async function buildIdentifiedApp() {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      const principalId = String(request.headers['x-principal'] ?? 'alice');
      const mayWrite = request.headers['x-access'] !== 'read';
      setRequestIdentity(request, {
        principal: {
          principalId,
          kind: 'user',
          displayName: `Name of ${principalId}`,
        },
        member: true,
        owner: false,
        access: {
          can: async (level) => level === 'read' || mayWrite,
          claim: async () => {},
          workspaces: async () => 'all',
        },
      });
    });
    await app.register(presenceRoutes);
    await app.register(syncRoutes);
    return app;
  }
  const as = (principal: string, access: 'read' | 'write' = 'write') => ({
    'x-principal': principal,
    'x-access': access,
  });
  const key = '\u0000space-1';

  it("refuses a name sent by the page and shows the identity's name to other principals", async () => {
    const app = await buildIdentifiedApp();
    const named = await app.inject({
      method: 'POST',
      url: '/space-1/presence',
      headers: as('mallory'),
      payload: { pageId: 'page-m', displayName: 'Alice' },
    });
    expect(named.statusCode).toBe(400);
    expect(canvasPresence.snapshot(key, undefined, 'alice')).toEqual([]);

    const accepted = await app.inject({
      method: 'POST',
      url: '/space-1/presence',
      headers: as('mallory'),
      payload: { pageId: 'page-m', label: 'Phone' },
    });
    expect(accepted.statusCode).toBe(204);
    expect(canvasPresence.snapshot(key, undefined, 'alice')).toEqual([
      expect.objectContaining({
        label: 'Phone',
        displayName: 'Name of mallory',
        pageId: expect.not.stringMatching(/^page-m$/),
      }),
    ]);
    await app.close();
  });

  it("acts on the caller's own page only, whatever page id is quoted", async () => {
    const app = await buildIdentifiedApp();
    const post = (principal: string, url: string, payload: object) =>
      app.inject({ method: 'POST', url, headers: as(principal), payload });
    await post('alice', '/space-1/presence', {
      pageId: 'page-a',
      label: 'Alice laptop',
      selectedNodeIds: ['n1'],
    });

    // Overwrite, evict, exhaust: none of it reaches Alice's entry.
    await post('mallory', '/space-1/presence', {
      pageId: 'page-a',
      label: 'Spoofed',
      selectedNodeIds: [],
    });
    expect(
      (await post('mallory', '/space-1/presence/leave', { pageId: 'page-a' }))
        .statusCode,
    ).toBe(204);
    for (
      let index = 0;
      index < CANVAS_PRESENCE_LIMITS.maxReportsPerSecond + 5;
      index += 1
    )
      await post('mallory', '/space-1/presence', {
        pageId: 'page-a',
        pointer: { x: index, y: 0 },
      });

    // Alice's other device sees her page untouched, next to Mallory's own.
    const seen = canvasPresence.snapshot(key, 'page-a2', 'alice');
    expect(seen).toHaveLength(2);
    expect(seen.find((page) => page.pageId === 'page-a')).toMatchObject({
      label: 'Alice laptop',
      selectedNodeIds: ['n1'],
    });
    const again = await post('alice', '/space-1/presence', {
      pageId: 'page-a',
      pointer: { x: 1, y: 1 },
    });
    expect(again.statusCode).toBe(204);
    await app.close();
  });

  it('lets a read-only viewer show a pointer and a selection, but not hold the edit lock', async () => {
    const app = await buildIdentifiedApp();
    const response = await app.inject({
      method: 'POST',
      url: '/space-1/presence',
      headers: as('viewer', 'read'),
      payload: {
        pageId: 'page-v',
        pointer: { x: 3, y: 4 },
        selectedNodeIds: ['n1'],
        editingNodeIds: Array.from(
          { length: CANVAS_PRESENCE_LIMITS.maxNodeIds },
          (_, index) => `n${index}`,
        ),
      },
    });
    expect(response.statusCode).toBe(204);
    expect(canvasPresence.snapshot(key, undefined, 'alice')).toEqual([
      expect.objectContaining({
        pointer: { x: 3, y: 4 },
        selectedNodeIds: ['n1'],
        editingNodeIds: [],
      }),
    ]);

    // A caller who may write does hold it.
    await app.inject({
      method: 'POST',
      url: '/space-1/presence',
      headers: as('editor'),
      payload: { pageId: 'page-e', editingNodeIds: ['n7'] },
    });
    expect(
      canvasPresence
        .snapshot(key, undefined, 'alice')
        .map((page) => page.editingNodeIds),
    ).toEqual([[], ['n7']]);
    await app.close();
  });

  it('answers 429 when one principal has too many pages, and still admits others', async () => {
    const app = await buildIdentifiedApp();
    let last = 204;
    for (
      let index = 0;
      index <= CANVAS_PRESENCE_LIMITS.maxPagesPerPrincipal;
      index += 1
    ) {
      const response = await app.inject({
        method: 'POST',
        url: '/space-1/presence',
        headers: as('mallory'),
        payload: { pageId: `squat-${index}` },
      });
      last = response.statusCode;
      if (index === CANVAS_PRESENCE_LIMITS.maxPagesPerPrincipal)
        expect(response.json()).toMatchObject({
          code: 'PRESENCE_TOO_MANY_PAGES',
        });
    }
    expect(last).toBe(429);
    const other = await app.inject({
      method: 'POST',
      url: '/space-1/presence',
      headers: as('alice'),
      payload: { pageId: 'page-a' },
    });
    expect(other.statusCode).toBe(204);
    await app.close();
  });

  it("tells a stream which page made a content save only when the save was its own principal's", async () => {
    mocks.read.mockResolvedValue({ version: 1 });
    const app = await buildIdentifiedApp();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    /** Collect the stream's `invalidate` events. */
    async function invalidations(principal: string) {
      const controller = new AbortController();
      const response = await fetch(
        `${address}/space-1/sync/stream?pageId=page-a`,
        { signal: controller.signal, headers: as(principal) },
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Stream has no body');
      const events: unknown[] = [];
      let snapshot = false;
      let buffer = '';
      void (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return;
            buffer += new TextDecoder().decode(chunk.value);
            const parts = buffer.split('\n\n');
            buffer = parts.pop() ?? '';
            for (const part of parts) {
              if (part.startsWith('event: snapshot')) snapshot = true;
              const data = /^event: invalidate\ndata: (.*)$/.exec(part)?.[1];
              if (data) events.push(JSON.parse(data));
            }
          }
        } catch {
          /* aborted */
        }
      })();
      await vi.waitFor(() => expect(snapshot).toBe(true));
      return { events, close: () => controller.abort() };
    }
    try {
      // Alice's page and Mallory's page happen to use the same page id.
      const alice = await invalidations('alice');
      const mallory = await invalidations('mallory');

      // Mallory saves, quoting that page id.
      publishCanvasUpdate(
        'space-1',
        {
          type: 'invalidate',
          data: { nodeIds: ['n1'], originPageId: 'page-a' },
        },
        { principalId: 'mallory' },
      );
      // Alice saves.
      publishCanvasUpdate(
        'space-1',
        {
          type: 'invalidate',
          data: { nodeIds: ['n2'], originPageId: 'page-a' },
        },
        { principalId: 'alice' },
      );
      // A writer that names no principal.
      publishCanvasUpdate('space-1', {
        type: 'invalidate',
        data: { nodeIds: ['n3'], originPageId: 'page-a' },
      });

      await vi.waitFor(() => expect(alice.events).toHaveLength(3));
      await vi.waitFor(() => expect(mallory.events).toHaveLength(3));
      // Alice's page fetches Mallory's save; it skips only its own.
      expect(alice.events).toEqual([
        { nodeIds: ['n1'] },
        { nodeIds: ['n2'], originPageId: 'page-a' },
        { nodeIds: ['n3'] },
      ]);
      expect(mallory.events).toEqual([
        { nodeIds: ['n1'], originPageId: 'page-a' },
        { nodeIds: ['n2'] },
        { nodeIds: ['n3'] },
      ]);
      alice.close();
      mallory.close();
    } finally {
      await app.close();
    }
  });
});
