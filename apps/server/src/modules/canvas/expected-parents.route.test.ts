// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `expectedParents` on `POST /api/canvas/:canvasId/execute`: a browser page
 * states, per edit, the parent each node it places had when the edit was
 * made. An edit whose node has been moved into or out of a Frame by another
 * writer in the meantime is refused as a whole with `stale-parent`; nothing
 * is converted and nothing of that edit is applied.
 *
 * Exercised through Fastify `inject()` so the body schema, the route's
 * checks and the executor are covered together.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ExecuteRequestReusedError,
  executeOnServer,
} from './canvas-executor.js';
import canvasRoutes from './canvas.route.js';
import { getCanvasStore } from '../storage/index.js';
import { setWorkspacePath } from '../workspace.js';

import type { CanvasCommand } from '@huabu/shared';

const CANVAS = 'c1';
const N = 'node-n';
const INSIDE = 'node-inside';
const F = 'node-f';
const G = 'node-g';

let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const instance = fastify();
  await instance.register(canvasRoutes, { prefix: '/canvas' });
  await instance.ready();
  return instance;
}

const note = (id: string, x: number, y: number, parentId?: string) => ({
  id,
  type: 'note',
  position: { x, y },
  style: { width: 100, height: 60 },
  ...(parentId ? { parentId } : {}),
  data: { label: id, heightMode: 'fixed' },
});
const frame = (id: string, x: number) => ({
  id,
  type: 'frame',
  position: { x, y: 0 },
  style: { width: 220, height: 225 },
  data: { label: id, sizing: 'hug' },
});

/** N on the canvas, INSIDE within the hug Frame F, G empty. */
function seed(): void {
  getCanvasStore(CANVAS).write({
    canvasId: CANVAS,
    title: null,
    version: 1,
    state: {
      nodes: [
        note(N, 600, 600),
        frame(F, 0),
        note(INSIDE, 20, 60, F),
        frame(G, 1200),
      ],
      edges: [],
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

const move = (id: string, x: number, y: number) => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId: id, position: { x, y } }],
});
const reparent = (id: string, parentId: string | null) => ({
  type: 'SET_NODE_PARENT',
  nodeIds: [id],
  parentId,
});

function execute(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/canvas/${CANVAS}/execute`,
    payload: { originator: { source: 'ui' }, ...payload },
  });
}

interface StoredNode {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
  style?: { width?: number; height?: number };
}
const stored = (id: string): StoredNode => {
  const nodes = (getCanvasStore(CANVAS).read()?.state.nodes ??
    []) as StoredNode[];
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`Missing node ${id}`);
  return node;
};
const version = () => getCanvasStore(CANVAS).read()?.version;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'huabu-expected-parents-'));
  setWorkspacePath(tmp);
  seed();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('POST /execute with expectedParents', () => {
  it('applies a move whose node is still under the stated parent', async () => {
    const response = await execute({
      commands: [move(N, 700, 650)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: null } }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toMatchObject([{ applied: true }]);
    expect(stored(N).position).toEqual({ x: 700, y: 650 });
  });

  it('refuses a canvas move committed after another page dragged the node into a Frame', async () => {
    // Page A: N into F.
    const first = await execute({
      commands: [reparent(N, F)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: null } }],
    });
    expect(first.json().results).toMatchObject([{ applied: true }]);
    const afterA = {
      n: structuredClone(stored(N)),
      frame: structuredClone(stored(F)),
      version: version(),
    };
    expect(afterA.n.parentId).toBe(F);

    // Page B had not heard of it: a plain move, in canvas coordinates.
    const second = await execute({
      commands: [move(N, 620, 820)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: null } }],
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
    ]);
    expect(body.toVersion).toBe(body.fromVersion);
    expect(body.deltas).toEqual([]);
    // A's edit stands: not B's coordinates read as Frame-local, and the hug
    // Frame did not grow.
    expect(stored(N)).toEqual(afterA.n);
    expect(stored(F)).toEqual(afterA.frame);
    expect(version()).toBe(afterA.version);
  });

  it('refuses a move inside a Frame committed after another page dragged the node out (the mirror case)', async () => {
    const first = await execute({
      commands: [reparent(INSIDE, null)],
      expectedParents: [{ start: 0, count: 1, parents: { [INSIDE]: F } }],
    });
    expect(first.json().results).toMatchObject([{ applied: true }]);
    const afterA = structuredClone(stored(INSIDE));
    expect(afterA.parentId).toBeUndefined();

    const second = await execute({
      commands: [move(INSIDE, 40, 120)],
      expectedParents: [{ start: 0, count: 1, parents: { [INSIDE]: F } }],
    });
    expect(second.json().results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
    ]);
    expect(stored(INSIDE)).toEqual(afterA);
  });

  it('refuses the later of two drags of one node into different Frames, with its position', async () => {
    const first = await execute({
      commands: [reparent(N, F), move(N, 20, 150)],
      expectedParents: [{ start: 0, count: 2, parents: { [N]: null } }],
    });
    expect(first.json().results).toMatchObject([
      { applied: true },
      { applied: true },
    ]);
    const afterA = structuredClone(stored(N));

    const second = await execute({
      commands: [reparent(N, G), move(N, 30, 70)],
      expectedParents: [{ start: 0, count: 2, parents: { [N]: null } }],
    });
    // Without the statement the second batch would move N from F into G.
    expect(second.json().results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
      { applied: false, reason: 'stale-parent' },
    ]);
    expect(stored(N)).toEqual(afterA);
    expect(stored(N).parentId).toBe(F);
  });

  it('refuses one edit and applies the other edits of the same request', async () => {
    await execute({ commands: [reparent(N, F)] });
    const response = await execute({
      commands: [move(N, 620, 820), move(INSIDE, 25, 65)],
      expectedParents: [
        { start: 0, count: 1, parents: { [N]: null } },
        { start: 1, count: 1, parents: { [INSIDE]: F } },
      ],
    });
    expect(response.json().results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
      { applied: true },
    ]);
    expect(stored(N).parentId).toBe(F);
  });

  it('refuses an edit whose node was deleted, with stale-target', async () => {
    await execute({ commands: [{ type: 'DELETE_NODES', nodeIds: [N] }] });
    const response = await execute({
      commands: [move(N, 1, 1)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: null } }],
    });
    expect(response.json().results).toMatchObject([
      { applied: false, reason: 'stale-target' },
    ]);
  });

  it('executes a request without the field exactly as before', async () => {
    await execute({ commands: [reparent(N, F)] });
    const response = await execute({ commands: [move(N, 30, 150)] });
    expect(response.json().results).toMatchObject([{ applied: true }]);
    // Read as Frame-local: the behaviour callers without the field keep.
    expect(stored(N).parentId).toBe(F);
  });

  it('rejects runs that do not fit the commands, and the field on a non-ui batch', async () => {
    const outOfRange = await execute({
      commands: [move(N, 1, 1)],
      expectedParents: [{ start: 0, count: 2, parents: { [N]: null } }],
    });
    expect(outOfRange.statusCode).toBe(400);
    const overlapping = await execute({
      commands: [move(N, 1, 1), move(N, 2, 2)],
      expectedParents: [
        { start: 0, count: 2, parents: { [N]: null } },
        { start: 1, count: 1, parents: { [N]: null } },
      ],
    });
    expect(overlapping.statusCode).toBe(400);
    const malformed = await execute({
      commands: [move(N, 1, 1)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: 7 } }],
    });
    expect(malformed.statusCode).toBe(400);
    const agent = await execute({
      originator: { source: 'agent' },
      commands: [move(N, 1, 1)],
      expectedParents: [{ start: 0, count: 1, parents: { [N]: null } }],
    });
    expect(agent.statusCode).toBe(400);
    expect(stored(N).position).toEqual({ x: 600, y: 600 });
  });
});

describe('expectedParents and request ids', () => {
  const principalId = 'user:alice';
  const commands = [move(N, 620, 820)] as unknown as CanvasCommand[];
  const expectedParents = [{ start: 0, count: 1, parents: { [N]: null } }];

  it('answers a repeated request from the stored refusal and treats other parents as another request', async () => {
    await executeOnServer({
      canvasId: CANVAS,
      commands: [reparent(N, F)] as unknown as CanvasCommand[],
      originator: { source: 'ui' },
    });
    const operationId = randomUUID();
    const input = {
      canvasId: CANVAS,
      commands,
      originator: { source: 'ui' as const },
      request: { operationId, principalId },
      expectedParents,
    };
    const first = await executeOnServer(input);
    expect(first.results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
    ]);
    const again = await executeOnServer(input);
    expect(again.replayed).toBe(true);
    expect(again.results).toMatchObject([
      { applied: false, reason: 'stale-parent' },
    ]);
    await expect(
      executeOnServer({
        ...input,
        expectedParents: [{ start: 0, count: 1, parents: { [N]: F } }],
      }),
    ).rejects.toBeInstanceOf(ExecuteRequestReusedError);
  });
});
