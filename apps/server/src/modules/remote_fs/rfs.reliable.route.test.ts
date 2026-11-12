// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Request ids and read versions at the HTTP entry points.
 *
 * The executor's own behaviour is covered by
 * `canvas/canvas-executor.reliable.test.ts`; this suite checks what the two
 * routes add: where the fields are accepted, which principal a stored
 * response belongs to, how the executor's errors are reported, and that a
 * repeated request is answered with the same response.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import multipart from '@fastify/multipart';
import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RFS_HEADERS,
  parseBasis,
  rfsCapabilitiesResponseSchema,
  rfsExecuteResponseSchema,
  spaceQueryResponseSchema,
} from '@huabu/shared';

import rfsRoutes from './rfs.route.js';
import { toSafeFilename } from '../../utils/naming.js';
import canvasRoutes from '../canvas/canvas.route.js';
import { setRequestIdentity } from '../identity/request.js';
import { UNRESTRICTED_ACCESS } from '../identity/service.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type * as StorageModule from '../storage/index.js';

/** Storage faults a test can switch on for the executor's Space handle. */
const faults = vi.hoisted(() => ({
  write: null as null | (() => never),
  lookup: null as null | ((real: () => Promise<unknown>) => unknown),
}));

vi.mock('../storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StorageModule>();
  return {
    ...actual,
    space: (canvasId: string) => {
      const handle = actual.space(canvasId);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === 'write' && faults.write) return faults.write;
          if (property === 'save' && faults.lookup) {
            const { lookup } = faults;
            const save = target.save;
            return {
              stamps: () => save.stamps(),
              record: (input: never) => save.record(input),
              lookup: (key: never) => lookup(() => save.lookup(key)),
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
});

const OP_1 = '11111111-1111-4111-8111-111111111111';
const OP_2 = '22222222-2222-4222-8222-222222222222';
const ALICE = { 'x-test-principal': 'user:alice' };
const BOB = { 'x-test-principal': 'user:bob' };

let tmp: string;

async function buildApp() {
  const app = fastify();
  // The principal is the transport's. A request without the test header is
  // an unauthenticated one, as in the suites that register no identity.
  app.addHook('onRequest', async (request) => {
    const principalId = request.headers['x-test-principal'];
    if (typeof principalId !== 'string') return;
    setRequestIdentity(request, {
      principal: { principalId, kind: 'bot' },
      member: true,
      owner: true,
      access: UNRESTRICTED_ACCESS,
    });
  });
  await app.register(multipart);
  await app.register(rfsRoutes, { prefix: '/rfs' });
  await app.register(canvasRoutes, { prefix: '/canvas' });
  await app.ready();
  return app;
}

type App = Awaited<ReturnType<typeof buildApp>>;

function seed(): string {
  const store = getCanvasStore('c1');
  store.write({
    canvasId: 'c1',
    title: null,
    version: 1,
    state: {
      nodes: [
        {
          id: 'frame-1',
          type: 'frame',
          position: { x: 0, y: 400 },
          style: { width: 300, height: 300 },
          data: { label: 'Frame', sizing: 'manual' },
        },
        {
          id: 'node-1',
          type: 'note',
          position: { x: 0, y: 0 },
          style: { width: 200, height: 100 },
          data: { label: 'Alpha' },
        },
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  store.writeNode('node-1', {
    nodeId: 'node-1',
    type: 'note',
    label: 'Alpha',
    content: 'alpha body',
  });
  return `nodes/${toSafeFilename('Alpha', 'node-1')}.md`;
}

const createNote = (label: string) => ({
  type: 'CREATE_NODES',
  nodes: [
    {
      nodeType: 'note',
      data: { label, content: `# ${label}` },
      position: { x: 600, y: 0 },
    },
  ],
});

function execute(
  app: App,
  payload: Record<string, unknown>,
  headers: Record<string, string> = ALICE,
) {
  return app.inject({
    method: 'POST',
    url: '/rfs/c1/execute',
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}

async function query(app: App, payload: Record<string, unknown>) {
  const response = await app.inject({
    method: 'POST',
    url: '/rfs/c1/query',
    headers: { 'content-type': 'application/json', ...ALICE },
    payload,
  });
  expect(response.statusCode).toBe(200);
  return spaceQueryResponseSchema.parse(response.json());
}

const nodeCount = () =>
  (getCanvasStore('c1').read()?.state.nodes as unknown[]).length;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-rfs-reliable-'));
  setWorkspacePath(tmp);
  faults.write = null;
  faults.lookup = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('POST /api/rfs/:canvasId/execute with a request id', () => {
  it('answers a repeated request with the original response and applies it once', async () => {
    seed();
    const app = await buildApp();
    try {
      const payload = { operationId: OP_1, commands: [createNote('Once')] };
      const first = await execute(app, payload);
      expect(first.statusCode).toBe(200);
      const original = rfsExecuteResponseSchema.parse(first.json());
      expect(original).toMatchObject({
        operationId: OP_1,
        fromVersion: 1,
        toVersion: 2,
        results: [{ applied: true }],
      });
      expect(original.replayed).toBeUndefined();
      expect(parseBasis(original.basis ?? '')).toMatchObject({ version: 2 });
      expect(original.runId).toMatch(/^run-/);
      expect(nodeCount()).toBe(3);

      // The repeat carries another run label: it is not part of the request.
      const second = await execute(app, { ...payload, runId: 'retry-label' });
      expect(second.statusCode).toBe(200);
      const replayed = rfsExecuteResponseSchema.parse(second.json());
      expect(replayed).toEqual({ ...original, replayed: true });
      expect(Object.keys(second.json()).sort()).toEqual(
        [...Object.keys(first.json()), 'replayed'].sort(),
      );
      expect(nodeCount()).toBe(3);
      expect(getCanvasStore('c1').read()?.version).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('accepts the request id and basis in headers and refuses a contradiction', async () => {
    seed();
    const app = await buildApp();
    try {
      const { basis } = await query(app, { type: 'GET_SPACE_OUTLINE' });
      const viaHeader = await execute(
        app,
        { commands: [createNote('Header')] },
        { ...ALICE, 'x-huabu-operation-id': OP_1, 'x-huabu-basis': basis },
      );
      expect(viaHeader.statusCode).toBe(200);
      expect(viaHeader.json()).toMatchObject({ operationId: OP_1 });

      // Header and body naming the same id is the same request.
      const both = await execute(
        app,
        { operationId: OP_1, basis, commands: [createNote('Header')] },
        { ...ALICE, 'x-huabu-operation-id': OP_1.toUpperCase() },
      );
      expect(both.statusCode).toBe(200);
      expect(both.json()).toMatchObject({ operationId: OP_1, replayed: true });

      const mismatch = await execute(
        app,
        { operationId: OP_2, commands: [createNote('Other')] },
        { ...ALICE, 'x-huabu-operation-id': OP_1 },
      );
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.json()).toMatchObject({ code: 'validation_failed' });

      const basisMismatch = await execute(
        app,
        { basis, commands: [createNote('Other')] },
        { ...ALICE, 'x-huabu-basis': `${basis}0` },
      );
      expect(basisMismatch.statusCode).toBe(400);

      const malformed = await execute(
        app,
        { commands: [createNote('Other')] },
        { ...ALICE, 'x-huabu-operation-id': 'not-a-uuid' },
      );
      expect(malformed.statusCode).toBe(400);

      const malformedBody = await execute(app, {
        operationId: 'not-a-uuid',
        commands: [createNote('Other')],
      });
      expect(malformedBody.statusCode).toBe(400);
      expect(nodeCount()).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('requires an authenticated caller for a request id, and none without one', async () => {
    seed();
    const app = await buildApp();
    try {
      const anonymous = await execute(
        app,
        { operationId: OP_1, commands: [createNote('Anon')] },
        {},
      );
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json()).toMatchObject({ code: 'identity_required' });
      expect(nodeCount()).toBe(2);

      // Without a request id nothing is stored, and each send applies.
      const plain = { commands: [createNote('Plain')] };
      const first = rfsExecuteResponseSchema.parse(
        (await execute(app, plain, {})).json(),
      );
      const second = rfsExecuteResponseSchema.parse(
        (await execute(app, plain, {})).json(),
      );
      expect(first.operationId).toBeUndefined();
      expect(first.basis).toEqual(expect.any(String));
      expect(second.replayed).toBeUndefined();
      expect(nodeCount()).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('reports a reused request id as 409 operation-id-reused', async () => {
    seed();
    const app = await buildApp();
    try {
      await execute(app, { operationId: OP_1, commands: [createNote('A')] });
      const reused = await execute(app, {
        operationId: OP_1,
        commands: [createNote('B')],
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'operation-id-reused' });
      expect(nodeCount()).toBe(3);

      // The same id under another principal is another request.
      const other = await execute(
        app,
        { operationId: OP_1, commands: [createNote('B')] },
        BOB,
      );
      expect(other.statusCode).toBe(200);
      expect(other.json().replayed).toBeUndefined();
      expect(nodeCount()).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('reports a basis of another history as 409 basis-unknown', async () => {
    seed();
    const app = await buildApp();
    try {
      for (const basis of [
        'b1.00000000-0000-4000-8000-000000000000.1',
        'not-a-basis',
      ]) {
        const response = await execute(app, {
          basis,
          commands: [createNote('Never')],
        });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'basis-unknown' });
      }
      expect(nodeCount()).toBe(2);
    } finally {
      await app.close();
    }
  });

  it('reports an unknown outcome as 503 operation-outcome-unknown', async () => {
    seed();
    const app = await buildApp();
    try {
      let lookups = 0;
      faults.write = () => {
        throw new Error('connection lost');
      };
      faults.lookup = (real) => {
        lookups += 1;
        // The lookups before the write succeed; the one after it does not.
        if (lookups <= 2) return real();
        throw new Error('connection still lost');
      };
      const unknown = await execute(app, {
        operationId: OP_1,
        commands: [createNote('Maybe')],
      });
      expect(unknown.statusCode).toBe(503);
      expect(unknown.json()).toMatchObject({
        code: 'operation-outcome-unknown',
      });

      // Without a request id the same failure stays an ordinary error.
      faults.lookup = null;
      const plain = await execute(app, { commands: [createNote('Maybe')] });
      expect(plain.statusCode).toBe(500);
      expect(plain.json().code).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects a structural edit built on a stale read, per command', async () => {
    seed();
    const app = await buildApp();
    try {
      const { basis } = await query(app, {
        type: 'INSPECT_NODES',
        ids: ['node-1'],
      });
      // Someone else moves the node into a frame after the read.
      const moved = await execute(app, {
        commands: [
          { type: 'SET_NODE_PARENT', nodeIds: ['node-1'], parentId: 'frame-1' },
        ],
      });
      expect(moved.json()).toMatchObject({ results: [{ applied: true }] });

      const stale = rfsExecuteResponseSchema.parse(
        (
          await execute(app, {
            basis,
            commands: [
              {
                type: 'SET_NODE_GEOMETRY',
                items: [{ nodeId: 'node-1', position: { x: 10, y: 10 } }],
              },
              createNote('Still applies'),
            ],
          })
        ).json(),
      );
      expect(stale.results).toMatchObject([
        { applied: false, reason: 'stale-parent' },
        { applied: true },
      ]);

      // The basis of the response describes the state it left behind.
      const fresh = await execute(app, {
        basis: stale.basis,
        commands: [
          {
            type: 'SET_NODE_GEOMETRY',
            items: [{ nodeId: 'node-1', position: { x: 10, y: 10 } }],
          },
        ],
      });
      expect(fresh.json()).toMatchObject({ results: [{ applied: true }] });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/rfs/:canvasId/execute/:operationId', () => {
  it('returns the stored response to its principal only', async () => {
    seed();
    const app = await buildApp();
    try {
      const lookup = (id: string, headers: Record<string, string>) =>
        app.inject({ method: 'GET', url: `/rfs/c1/execute/${id}`, headers });

      expect((await lookup(OP_1, ALICE)).statusCode).toBe(404);

      const first = await execute(app, {
        operationId: OP_1,
        commands: [createNote('Stored')],
      });
      const original = rfsExecuteResponseSchema.parse(first.json());

      const found = await lookup(OP_1.toUpperCase(), ALICE);
      expect(found.statusCode).toBe(200);
      expect(rfsExecuteResponseSchema.parse(found.json())).toEqual({
        ...original,
        replayed: true,
      });

      const otherPrincipal = await lookup(OP_1, BOB);
      expect(otherPrincipal.statusCode).toBe(404);
      expect(otherPrincipal.json()).toMatchObject({
        code: 'operation_not_found',
      });
      expect((await lookup(OP_1, {})).statusCode).toBe(404);
      expect((await lookup(OP_2, ALICE)).statusCode).toBe(404);
      expect((await lookup('not-a-uuid', ALICE)).statusCode).toBe(400);
      // Looking a result up never executes anything.
      expect(nodeCount()).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('also stores an outcome that changed nothing', async () => {
    seed();
    const app = await buildApp();
    try {
      const payload = {
        operationId: OP_1,
        commands: [{ type: 'DELETE_NODES', nodeIds: ['node-missing'] }],
      };
      const first = rfsExecuteResponseSchema.parse(
        (await execute(app, payload)).json(),
      );
      expect(first).toMatchObject({
        fromVersion: 1,
        toVersion: 1,
        results: [{ applied: false }],
      });
      const found = await app.inject({
        method: 'GET',
        url: `/rfs/c1/execute/${OP_1}`,
        headers: ALICE,
      });
      expect(found.json()).toEqual({ ...first, replayed: true });
    } finally {
      await app.close();
    }
  });
});

describe('GET /api/rfs/:canvasId/execute/:operationId for another entry point', () => {
  it('reports a result stored by the canvas route as not found', async () => {
    seed();
    const app = await buildApp();
    try {
      // Same principal, but commands outside the agent vocabulary: the
      // stored response has no RFS form.
      const viaCanvas = await app.inject({
        method: 'POST',
        url: '/canvas/c1/execute',
        headers: ALICE,
        payload: {
          originator: { source: 'ui' },
          operationId: OP_1,
          commands: [
            {
              type: 'CREATE_NODES',
              nodes: [
                {
                  id: 'node-ui',
                  type: 'note',
                  position: { x: 900, y: 0 },
                  data: { label: 'UI' },
                },
              ],
            },
          ],
        },
      });
      expect(viaCanvas.statusCode).toBe(200);
      expect(viaCanvas.json()).toMatchObject({ operationId: OP_1 });

      const lookup = await app.inject({
        method: 'GET',
        url: `/rfs/c1/execute/${OP_1}`,
        headers: ALICE,
      });
      expect(lookup.statusCode).toBe(404);
      expect(lookup.json()).toMatchObject({ code: 'operation_not_found' });
    } finally {
      await app.close();
    }
  });
});

describe('Review attribution', () => {
  const THREAD = 'thread-here';
  const ELSEWHERE = 'thread-elsewhere';

  /** Give `canvasId` an Agent Node whose conversation is `threadId`. */
  function seedAgentNode(canvasId: string, threadId: string): void {
    const store = getCanvasStore(canvasId);
    const record = store.read() ?? {
      canvasId,
      title: null,
      version: 1,
      state: { nodes: [], edges: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const nodeId = `agent-${threadId}`;
    store.write({
      ...record,
      state: {
        ...record.state,
        nodes: [
          ...record.state.nodes,
          {
            id: nodeId,
            type: 'question',
            position: { x: 0, y: 900 },
            data: { threadId },
          },
        ],
      },
    });
    store.writeNode(nodeId, {
      nodeId,
      type: 'question',
      label: null,
      content: '',
    });
  }

  const changesOf = (canvasId: string, threadId: string) =>
    getCanvasStore(canvasId).readChanges(threadId);

  function seedBoth(): void {
    seed();
    seedAgentNode('c1', THREAD);
    seedAgentNode('c2', ELSEWHERE);
  }

  it('attributes an RFS execute to a thread of this Space', async () => {
    seedBoth();
    const app = await buildApp();
    try {
      const response = await execute(
        app,
        { commands: [createNote('Mine')] },
        { ...ALICE, 'x-huabu-host-thread-id': THREAD },
      );
      expect(response.statusCode).toBe(200);
      expect(changesOf('c1', THREAD)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('applies an RFS execute unattributed when the thread belongs to another Space', async () => {
    seedBoth();
    const app = await buildApp();
    try {
      const before = nodeCount();
      const response = await execute(
        app,
        { commands: [createNote('Not mine')] },
        { ...ALICE, 'x-huabu-host-thread-id': ELSEWHERE },
      );
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ results: [{ applied: true }] });
      expect(nodeCount()).toBe(before + 1);
      // Nothing is filed under the foreign thread, here or where it lives.
      expect(changesOf('c1', ELSEWHERE)).toEqual([]);
      expect(changesOf('c2', ELSEWHERE)).toEqual([]);
      expect(changesOf('c1', THREAD)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('still replays a request whose thread has left the Space since', async () => {
    seedBoth();
    const app = await buildApp();
    try {
      const headers = { ...ALICE, 'x-huabu-host-thread-id': THREAD };
      const payload = { operationId: OP_1, commands: [createNote('Once')] };
      const first = await execute(app, payload, headers);
      expect(first.statusCode).toBe(200);
      expect(changesOf('c1', THREAD)).toHaveLength(1);

      const removed = await execute(app, {
        commands: [{ type: 'DELETE_NODES', nodeIds: [`agent-${THREAD}`] }],
      });
      expect(removed.json()).toMatchObject({ results: [{ applied: true }] });

      const second = await execute(app, payload, headers);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ...first.json(), replayed: true });
      expect(changesOf('c1', THREAD)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('applies the same check to the thread id in a canvas execute body', async () => {
    seedBoth();
    const app = await buildApp();
    try {
      const post = (threadId: string, id: string) =>
        app.inject({
          method: 'POST',
          url: '/canvas/c1/execute',
          headers: ALICE,
          payload: {
            originator: { source: 'agent', threadId },
            commands: [
              {
                type: 'CREATE_NODES',
                nodes: [
                  {
                    id,
                    nodeType: 'note',
                    position: { x: 900, y: 0 },
                    data: { label: id, content: 'body' },
                  },
                ],
              },
            ],
          },
        });

      const foreign = await post(ELSEWHERE, 'node-foreign');
      expect(foreign.statusCode).toBe(200);
      expect(foreign.json()).toMatchObject({ toVersion: 2 });
      expect(changesOf('c1', ELSEWHERE)).toEqual([]);

      const own = await post(THREAD, 'node-own');
      expect(own.statusCode).toBe(200);
      expect(own.json()).toMatchObject({ toVersion: 3 });
      expect(changesOf('c1', THREAD)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});

describe('basis on RFS reads', () => {
  it('returns the current basis from every query type and tracks writes', async () => {
    seed();
    const app = await buildApp();
    try {
      const outline = await query(app, { type: 'GET_SPACE_OUTLINE' });
      const nodes = await query(app, {
        type: 'INSPECT_NODES',
        ids: ['node-1'],
      });
      const edges = await query(app, { type: 'INSPECT_EDGES' });
      const search = await query(app, { type: 'SEARCH', query: 'alpha' });
      expect(parseBasis(outline.basis)).toMatchObject({ version: 1 });
      // Reading does not move the version, and the lineage is created once.
      expect(new Set([nodes.basis, edges.basis, search.basis])).toEqual(
        new Set([outline.basis]),
      );

      const written = rfsExecuteResponseSchema.parse(
        (await execute(app, { commands: [createNote('Next')] })).json(),
      );
      const after = await query(app, { type: 'GET_SPACE_OUTLINE' });
      expect(after.basis).toBe(written.basis);
      expect(parseBasis(after.basis)).toEqual({
        lineage: parseBasis(outline.basis)?.lineage,
        version: 2,
      });

      const missing = await app.inject({
        method: 'POST',
        url: '/rfs/absent/query',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'INSPECT_EDGES' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'canvas_not_found' });
    } finally {
      await app.close();
    }
  });

  it('adds the basis header to a node download', async () => {
    const file = seed();
    const app = await buildApp();
    try {
      const { basis } = await query(app, { type: 'GET_SPACE_OUTLINE' });
      const download = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers[RFS_HEADERS.basis.toLowerCase()]).toBe(basis);
      expect(download.headers[RFS_HEADERS.nodeId.toLowerCase()]).toBe('node-1');

      // An unchanged node is not re-read, so no new read version is claimed.
      const unchanged = await app.inject({
        method: 'GET',
        url: `/rfs/c1/download/${file}`,
        headers: { 'if-none-match': String(download.headers.etag) },
      });
      expect(unchanged.statusCode).toBe(304);
      expect(
        unchanged.headers[RFS_HEADERS.basis.toLowerCase()],
      ).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('advertises the request id as the retry key', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/rfs/c1/capabilities',
      });
      expect(
        rfsCapabilitiesResponseSchema.parse(response.json()).execution,
      ).toEqual({
        atomic: false,
        partialCommit: true,
        idempotent: false,
        runIdIsIdempotencyKey: false,
        operationIdIsIdempotencyKey: true,
      });
    } finally {
      await app.close();
    }
  });
});

describe('POST /api/canvas/:canvasId/execute with a request id', () => {
  const uiCreate = {
    type: 'CREATE_NODES',
    nodes: [
      {
        id: 'node-ui',
        type: 'note',
        position: { x: 900, y: 0 },
        data: { label: 'UI' },
      },
    ],
  };
  const post = (
    app: App,
    payload: Record<string, unknown>,
    headers: Record<string, string> = ALICE,
  ) =>
    app.inject({
      method: 'POST',
      url: '/canvas/c1/execute',
      headers,
      payload: { originator: { source: 'ui' }, ...payload },
    });

  it('replays a repeated request and leaves the legacy call unchanged', async () => {
    seed();
    const app = await buildApp();
    try {
      const legacy = await post(app, { commands: [uiCreate] }, {});
      expect(legacy.statusCode).toBe(200);
      expect(legacy.json()).not.toHaveProperty('operationId');
      expect(legacy.json()).not.toHaveProperty('basis');
      expect(legacy.json()).not.toHaveProperty('runId');

      const payload = {
        operationId: OP_1,
        commands: [
          {
            type: 'SET_NODE_PARENT',
            nodeIds: ['node-ui'],
            parentId: 'frame-1',
          },
        ],
      };
      const first = await post(app, payload);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        operationId: OP_1,
        fromVersion: 2,
        toVersion: 3,
        basis: expect.any(String),
      });
      const second = await post(app, payload);
      expect(second.json()).toEqual({ ...first.json(), replayed: true });
      expect(getCanvasStore('c1').read()?.version).toBe(3);

      const anonymous = await post(app, payload, {});
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('maps the executor errors to stable codes', async () => {
    seed();
    const app = await buildApp();
    try {
      await post(app, { operationId: OP_1, commands: [uiCreate] });
      const reused = await post(app, {
        operationId: OP_1,
        commands: [{ type: 'DELETE_NODES', nodeIds: ['node-1'] }],
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'operation-id-reused' });

      const unknownBasis = await post(app, {
        basis: 'b1.00000000-0000-4000-8000-000000000000.1',
        commands: [{ type: 'DELETE_NODES', nodeIds: ['node-1'] }],
      });
      expect(unknownBasis.statusCode).toBe(409);
      expect(unknownBasis.json()).toMatchObject({ code: 'basis-unknown' });

      let lookups = 0;
      faults.write = () => {
        throw new Error('connection lost');
      };
      faults.lookup = (real) => {
        lookups += 1;
        if (lookups <= 2) return real();
        throw new Error('connection still lost');
      };
      const unknown = await post(app, {
        operationId: OP_2,
        commands: [{ type: 'DELETE_NODES', nodeIds: ['node-1'] }],
      });
      expect(unknown.statusCode).toBe(503);
      expect(unknown.json()).toMatchObject({
        code: 'operation-outcome-unknown',
      });
    } finally {
      await app.close();
    }
  });
});
