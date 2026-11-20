// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postCanvasExecute: vi.fn(),
  getCanvas: vi.fn(),
  putNodeContent: vi.fn(),
  preprocessNode: vi.fn(),
  postCanvasEvents: vi.fn(),
}));
vi.mock('../api', async (actual) => ({
  ...(await actual<typeof apiModule>()),
  ...api,
}));
vi.mock('../api/canvas', async (actual) => ({
  ...(await actual<typeof canvasApiModule>()),
  ...api,
}));
vi.mock('@/components/Common/Toast', () => ({
  toast: vi.fn(() => 'toast-id'),
  dismissToast: vi.fn(),
}));

import {
  readPaintKey,
  seedNodeOrder,
  type Delta,
  type NestableNode,
} from '@huabu/shared/canvas-engine';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  hasUnsavedCanvasEdits,
  resetCanvasSyncForTests,
  setCanvasSyncLineageForTests,
} from './canvasStore';
import {
  createFakeSpaceServer,
  FAKE_LINEAGE,
} from './canvasStore/sync/testing/fakeExecuteServer';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
import type { Node } from '@xyflow/react';

/**
 * Paint order between pages. This page is the real store; the server is the
 * real engine over a copy of the Space (see `canvasStore.browserSync.test.ts`
 * for the harness). Order is each node's own `data.paintKey`, so a reorder
 * travels as an ordinary node delta and is held, merged and undone per node.
 */

const SPACE = 'space-order';
const A = 'node-order-a';
const B = 'node-order-b';
const C = 'node-order-c';
const D = 'node-order-d';
const FRAME = 'node-order-frame';
const P = 'node-order-p';
const Q = 'node-order-q';
const R = 'node-order-r';

const note = (id: string, parentId?: string): Node => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  style: { width: 100, height: 100 },
  ...(parentId ? { parentId } : {}),
  data: {
    type: 'note',
    label: id,
    content: '',
    heightMode: 'fixed',
    style: { accent: 'white' },
  },
});
const frame = (id: string): Node => ({
  id,
  type: 'frame',
  position: { x: 0, y: 0 },
  style: { width: 600, height: 600 },
  data: { type: 'frame', label: id, sizing: 'manual' },
});

interface OwnRequest {
  request: PostCanvasExecuteRequest;
  response?: PostCanvasExecuteResponse;
  resolve: (response: PostCanvasExecuteResponse) => void;
}

const server = createFakeSpaceServer();
let own: OwnRequest[];
const state = () => useCanvasStore.getState();
const flush = () => vi.advanceTimersByTimeAsync(0);

/** The server commits this page's `index`-th request. */
function commit(index: number): PostCanvasExecuteResponse {
  const entry = own[index];
  entry.response ??= server.execute(SPACE, entry.request);
  return entry.response;
}
/** The request's HTTP answer reaches this page. */
async function answer(index: number, response = commit(index)) {
  own[index].resolve(response);
  await flush();
}
/** An `update` event reaches this page over the sync stream. */
function deliver(update: PostCanvasExecuteResponse) {
  const current = state();
  expect(update.fromVersion).toBe(current.version);
  current.applyServerDeltas(
    update.deltas as Delta[],
    update.toVersion,
    update.pendingEffects as Parameters<typeof current.applyServerDeltas>[2],
    false,
    {
      ...(update.operationId ? { operationId: update.operationId } : {}),
      source: 'ui',
      ...(update.nodeContentRevisions
        ? { nodeContentRevisions: update.nodeContentRevisions }
        : {}),
    },
  );
}
/** Another page writes; the server commits it at once. */
function remote(commands: CanvasCommand[]): PostCanvasExecuteResponse {
  return server.execute(SPACE, {
    operationId: crypto.randomUUID(),
    originator: { tabId: 'page-b' },
    edits: [{ commands }],
  });
}
const commandsOf = (request: PostCanvasExecuteRequest): unknown[] =>
  request.edits.flatMap((edit) => edit.commands);

const reorder = (
  nodeIds: string[],
  to: Extract<CanvasCommand, { type: 'REORDER_NODES' }>['to'],
): CanvasCommand =>
  ({ type: 'REORDER_NODES', nodeIds, to }) as unknown as CanvasCommand;
const move = (id: string, x: number): CanvasCommand => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId: id as `node-${string}`, position: { x, y: 0 } }],
});

const idsOf = (nodes: readonly Node[], parentId?: string): string[] =>
  nodes
    .filter((candidate) => (candidate.parentId ?? undefined) === parentId)
    .map((candidate) => candidate.id);
/** This page's children of `parentId` (the root when omitted), back to front. */
const here = (parentId?: string) => idsOf(state().nodes, parentId);
/** The server's children of `parentId`, back to front. */
const there = (parentId?: string) => idsOf(server.state.nodes, parentId);
const keysOf = (nodes: readonly Node[]): Record<string, string | undefined> =>
  Object.fromEntries(
    nodes.map((candidate) => [
      candidate.id,
      readPaintKey(candidate as unknown as NestableNode),
    ]),
  );
const keyHere = (id: string) => keysOf(state().nodes)[id];
/** This page and the server hold the same array order and the same keys. */
function expectSameAsServer() {
  expect(state().nodes.map((n) => n.id)).toEqual(
    server.state.nodes.map((n) => n.id),
  );
  expect(keysOf(state().nodes)).toEqual(keysOf(server.state.nodes));
  expect(state().version).toBe(server.state.version);
}

/** Load a Space on both sides, keyed as the server's read keys it. */
function load(nodes: Node[]) {
  const loaded = seedNodeOrder(
    nodes as unknown as NestableNode[],
  ) as unknown as Node[];
  server.reset(loaded, [], 1);
  state()._setStateRaw({
    canvasId: SPACE,
    canvasTitle: 'Order',
    nodes: loaded,
    edges: [],
    version: 1,
    isLoading: false,
    canUndo: false,
    canRedo: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  setCanvasSyncLineageForTests(SPACE, FAKE_LINEAGE);
  own = [];
  canvasHistoryManager.activate(SPACE, true);
  load([note(A), note(B), note(C), note(D)]);
  api.postCanvasExecute.mockImplementation(
    (_canvasId: string, request: PostCanvasExecuteRequest) =>
      new Promise((resolve) => {
        own.push({ request: structuredClone(request), resolve });
      }),
  );
  api.getCanvas.mockImplementation(async (canvasId: string) => ({
    canvasId,
    title: 'Order',
    version: server.state.version,
    basis: server.basis(),
    state: { nodes: server.state.nodes, edges: server.state.edges },
  }));
  api.putNodeContent.mockResolvedValue({ nodeId: A, label: null, rev: 'rev' });
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ success: true });
});

afterEach(async () => {
  useCanvasStore.setState({ nodes: [], isLoading: false });
  await vi.advanceTimersByTimeAsync(5_000);
  resetCanvasSyncForTests();
  canvasHistoryManager.consumeGestureSnapshot();
  canvasHistoryManager.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("another page's reorder", () => {
  it('arrives as a node delta and shows here without a reload', async () => {
    const update = remote([reorder([A], 'top')]);
    expect(there()).toEqual([B, C, D, A]);
    // One row, for the one node that moved: its key.
    const rows = (update.deltas ?? []) as Delta[];
    expect(rows).toHaveLength(1);
    const row = rows[0] as Extract<Delta, { type: 'REPLACE_NODE' }>;
    expect(row).toMatchObject({
      type: 'REPLACE_NODE',
      prev: { id: A, data: { paintKey: keyHere(A) } },
      next: { id: A, data: { paintKey: expect.any(String) } },
    });
    expect(Object.keys(row.next.data ?? {})).toEqual(['paintKey']);
    expect(update).not.toHaveProperty('orderEvents');

    deliver(update);
    expect(here()).toEqual([B, C, D, A]);
    expectSameAsServer();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(own).toHaveLength(0);
    // Another person's reorder is not this page's to undo.
    expect(state().canUndo).toBe(false);
  });

  it('moves a node between two others, leaving their keys alone', () => {
    const before = keysOf(state().nodes);
    deliver(remote([reorder([D], { after: A })]));
    expect(here()).toEqual([A, D, B, C]);
    expect(keysOf(state().nodes)).toEqual({ ...before, [D]: keyHere(D) });
    expect(keyHere(D)).not.toBe(before[D]);
    expectSameAsServer();
  });

  it('reorders the children of a Frame and keeps each subtree contiguous', () => {
    load([frame(FRAME), note(P, FRAME), note(Q, FRAME), note(A)]);
    deliver(remote([reorder([P], 'top')]));
    expect(here(FRAME)).toEqual([Q, P]);
    deliver(remote([reorder([A], 'bottom')]));
    expect(state().nodes.map((n) => n.id)).toEqual([A, FRAME, Q, P]);
    expectSameAsServer();
  });

  it('places a node another page created where the server placed it', () => {
    const E = 'node-order-e';
    deliver(
      remote([
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: E as `node-${string}`,
              nodeType: 'note',
              placementPoint: { x: 0, y: 0 },
            },
          ],
        } as unknown as CanvasCommand,
        reorder([E], { after: A }),
      ]),
    );
    expect(here()).toEqual([A, E, B, C, D]);
    expectSameAsServer();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('leaves an update that changes nothing exactly as before', () => {
    state().applyServerDeltas([], 2, {
      mutatedNodeIds: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    });
    expect(here()).toEqual([A, B, C, D]);
    expect(state().version).toBe(2);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});

describe('two pages changing the layer of different nodes under one parent', () => {
  it('both survive, whichever the server commits first', async () => {
    // This page brings A to the front; the request is on its way.
    state().executeCommands([reorder([A], 'top')]);
    expect(here()).toEqual([B, C, D, A]);
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([reorder([A], 'top')]);

    // Meanwhile another page sends C to the back, and the server takes
    // that first. Its update is about C alone, so nothing of it is held.
    const update = remote([reorder([C], 'bottom')]);
    deliver(update);
    expect(here()).toEqual([C, B, D, A]);

    await answer(0);
    expect(there()).toEqual([C, B, D, A]);
    expect(here()).toEqual([C, B, D, A]);
    expectSameAsServer();
    expect(hasUnsavedCanvasEdits()).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('both survive when this page hears of the other reorder only after its own answer', async () => {
    state().executeCommands([reorder([A], 'top')]);
    commit(0);
    const update = remote([reorder([C], 'bottom')]);
    await answer(0);
    expect(here()).toEqual([B, C, D, A]);
    deliver(update);
    expect(here()).toEqual([C, B, D, A]);
    expectSameAsServer();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('both survive inside a Frame', async () => {
    load([frame(FRAME), note(P, FRAME), note(Q, FRAME), note(R, FRAME)]);
    state().executeCommands([reorder([P], 'top')]);
    expect(here(FRAME)).toEqual([Q, R, P]);
    deliver(remote([reorder([R], 'bottom')]));
    expect(here(FRAME)).toEqual([R, Q, P]);
    await answer(0);
    expect(there(FRAME)).toEqual([R, Q, P]);
    expectSameAsServer();
  });

  it("keeps this page's place for a node both pages reordered until its own answer, then agrees with the server", async () => {
    state().executeCommands([reorder([A], 'top')]);
    // Another page puts the same node elsewhere first.
    deliver(remote([reorder([A], { after: B })]));
    // The unit is held: this page keeps showing its own choice.
    expect(here()).toEqual([B, C, D, A]);
    await answer(0);
    expect(there()).toEqual([B, C, D, A]);
    expectSameAsServer();
  });
});

describe('undo of a reorder', () => {
  it("restores only that node's place and keeps another page's later reorder of a different node", async () => {
    const original = keysOf(state().nodes);
    state().executeCommands([reorder([A], 'top')]);
    await answer(0);
    expect(here()).toEqual([B, C, D, A]);
    expect(state().canUndo).toBe(true);

    deliver(remote([reorder([C], { after: D })]));
    expect(here()).toEqual([B, D, C, A]);
    const remoteKey = keyHere(C);
    expect(remoteKey).not.toBe(original[C]);

    state().undo();
    // A is back where it was; C stays where the other page put it.
    expect(here()).toEqual([A, B, D, C]);
    expect(keyHere(A)).toBe(original[A]);
    expect(keyHere(C)).toBe(remoteKey);
    expect(own).toHaveLength(2);
    // What is sent is A's key alone.
    expect(commandsOf(own[1].request)).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: A, patch: { paintKey: original[A] } }],
      },
    ]);

    await answer(1);
    expect(there()).toEqual([A, B, D, C]);
    expectSameAsServer();

    state().redo();
    expect(here()).toEqual([B, D, C, A]);
    await answer(2);
    expect(there()).toEqual([B, D, C, A]);
    expect(keyHere(C)).toBe(remoteKey);
    expectSameAsServer();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('agrees with the server when the restored key equals one another page has since given a sibling', async () => {
    const original = keysOf(state().nodes);
    state().executeCommands([reorder([A], 'top')]);
    await answer(0);
    // With A gone from the back, the other page's "send C to the back"
    // is keyed below B: the key A had.
    deliver(remote([reorder([C], 'bottom')]));
    expect(here()).toEqual([C, B, D, A]);
    expect(keyHere(C)).toBe(original[A]);

    state().undo();
    // Two equal keys order by id, the same way on both sides.
    expect(keyHere(A)).toBe(original[A]);
    expect(keyHere(C)).toBe(original[A]);
    expect(here()).toEqual([A, C, B, D]);
    await answer(1);
    expect(there()).toEqual([A, C, B, D]);
    expectSameAsServer();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('puts a node back between the siblings it stood between', async () => {
    const original = keysOf(state().nodes);
    state().executeCommands([reorder([B], 'top')]);
    await answer(0);
    expect(here()).toEqual([A, C, D, B]);
    state().undo();
    expect(here()).toEqual([A, B, C, D]);
    await answer(1);
    expect(keysOf(server.state.nodes)).toEqual(original);
    expectSameAsServer();
  });
});

describe('a reorder made while another change is in flight', () => {
  it('follows an unanswered move of the same node and both land', async () => {
    state().executeCommands([move(A, 500)]);
    expect(own).toHaveLength(1);
    state().executeCommands([reorder([A], 'top')]);
    // Shown at once, whatever is still on its way.
    expect(here()).toEqual([B, C, D, A]);

    await answer(0);
    await flush();
    expect(own).toHaveLength(2);
    expect(commandsOf(own[1].request)).toEqual([reorder([A], 'top')]);
    expect(here()).toEqual([B, C, D, A]);
    await answer(1);
    expect(there()).toEqual([B, C, D, A]);
    expect(state().nodes.find((n) => n.id === A)?.position).toEqual({
      x: 500,
      y: 0,
    });
    expectSameAsServer();
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it("is kept through another page's update that arrives before either answer", async () => {
    state().executeCommands([move(B, 500)]);
    state().executeCommands([reorder([A], 'top')]);
    // Another page reorders a different node and moves a third.
    deliver(remote([reorder([D], 'bottom'), move(C, 900)]));
    expect(here()).toEqual([D, B, C, A]);

    await answer(0);
    await flush();
    await answer(1);
    expect(there()).toEqual([D, B, C, A]);
    expectSameAsServer();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('of a node this page created and the server has not confirmed yet', async () => {
    state().addNode({
      nodeType: 'note',
      placementPoint: { x: 700, y: 700 },
      data: { content: 'New' },
    });
    const created = state().nodes.find((n) => ![A, B, C, D].includes(n.id))
      ?.id as string;
    expect(here()).toEqual([A, B, C, D, created]);
    state().executeCommands([reorder([created], 'bottom')]);
    expect(here()).toEqual([created, A, B, C, D]);

    await answer(0);
    await flush();
    expect(here()).toEqual([created, A, B, C, D]);
    await answer(1);
    expect(there()).toEqual([created, A, B, C, D]);
    expectSameAsServer();
  });
});
