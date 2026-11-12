// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  putCanvas: vi.fn(),
  postCanvasExecute: vi.fn(),
  getCanvas: vi.fn(),
  deleteNode: vi.fn(),
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

import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  hasUnsavedCanvasEdits,
  requestCanvasResync,
  resetCanvasSyncForTests,
} from './canvasStore';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

/**
 * Page A is the real store. The server is the real engine over a copy of the
 * Space. This page's requests are held until the test commits and answers
 * them, and another page's edits are run on the server and delivered to this
 * page the way the Canvas Sync stream does: in version order, applied only
 * when contiguous.
 */

const SPACE = 'space-sync';
const X = 'node-sync-x';
const Y = 'node-sync-y';

const note = (id: string, x: number, y: number): Node => ({
  id,
  type: 'note',
  position: { x, y },
  style: { width: 300, height: 200 },
  data: {
    type: 'note',
    label: `Label ${id}`,
    content: `Body ${id}`,
    heightMode: 'fixed',
    style: { accent: 'white' },
  },
});

interface OwnRequest {
  request: PostCanvasExecuteRequest;
  response?: PostCanvasExecuteResponse;
  resolve: (response: PostCanvasExecuteResponse) => void;
  reject: (error: unknown) => void;
}

const server = createFakeSpaceServer();
let own: OwnRequest[];
const state = () => useCanvasStore.getState();
const node = (id: string): Node => {
  const found = state().nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing node ${id}`);
  return found;
};
const serverNode = (id: string) =>
  server.state.nodes.find((candidate) => candidate.id === id);
const accentOf = (value: Node | undefined) =>
  (value?.data.style as { accent?: string } | undefined)?.accent;
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
function deliver(update: PostCanvasExecuteResponse, source: 'ui' | 'agent') {
  const current = state();
  if (update.fromVersion !== current.version) return false;
  current.applyDeltasFromAgent(
    update.deltas as Delta[],
    update.toVersion,
    update.pendingEffects as Parameters<typeof current.applyDeltasFromAgent>[2],
    false,
    { events: update.orderEvents },
    {
      ...(update.operationId ? { operationId: update.operationId } : {}),
      source,
    },
  );
  return true;
}
/** Another page (or an agent) writes; the server commits it at once. */
function remote(commands: CanvasCommand[]): PostCanvasExecuteResponse {
  return server.execute(SPACE, {
    commands,
    originator: { source: 'ui', tabId: 'page-b' },
    operationId: crypto.randomUUID(),
  });
}
const moveCommand = (id: string, x: number, y = 0): CanvasCommand => ({
  type: 'SET_NODE_GEOMETRY',
  items: [{ nodeId: id as `node-${string}`, position: { x, y } }],
});
const accentCommand = (id: string, accent: string): CanvasCommand => ({
  type: 'MERGE_NODE_DATA',
  patches: [{ nodeId: id as `node-${string}`, patch: { style: { accent } } }],
});
/** A committed move made on this page (a programmatic move, not a drag). */
function moveHere(id: string, x: number, y = 0) {
  state().beginGesture('SET_NODE_GEOMETRY');
  state().setNodeGeometry([{ nodeId: id, position: { x, y } }]);
}
function recolourHere(id: string, accent: string) {
  state().executeCommands([accentCommand(id, accent)]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  own = [];
  const nodes = [note(X, 0, 0), note(Y, 0, 300)];
  server.reset(nodes, [], 1);
  canvasHistoryManager.activate(SPACE, true);
  state()._setStateNoAutosave({
    canvasId: SPACE,
    canvasTitle: 'Sync',
    nodes,
    edges: [],
    version: 1,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
    canUndo: false,
    canRedo: false,
  });
  api.postCanvasExecute.mockImplementation(
    (_canvasId: string, request: PostCanvasExecuteRequest) =>
      new Promise((resolve, reject) => {
        own.push({ request: structuredClone(request), resolve, reject });
      }),
  );
  api.putCanvas.mockImplementation(
    async (canvasId: string, request: { version: number }) => ({
      canvasId,
      version: request.version + 1,
    }),
  );
  api.getCanvas.mockImplementation(async (canvasId: string) => ({
    canvasId,
    title: 'Sync',
    version: server.state.version,
    state: { nodes: server.state.nodes, edges: server.state.edges },
  }));
  api.deleteNode.mockResolvedValue({ success: true });
  api.putNodeContent.mockResolvedValue({ nodeId: X, label: null, rev: 'rev' });
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ success: true });
});

afterEach(async () => {
  // Release content-queue bookkeeping with the same deletion diff production
  // uses, so a pending body edit does not leak into the next case.
  useCanvasStore.setState({ nodes: [], isLoading: false });
  // Let the save that deletion scheduled run, so no timer is left armed.
  await vi.advanceTimersByTimeAsync(5_000);
  resetCanvasSyncForTests();
  canvasHistoryManager.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('sending a local edit', () => {
  it('takes effect at once and is sent with a request id and no read version', async () => {
    moveHere(X, 500);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([moveCommand(X, 500)]);
    expect(own[0].request.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(own[0].request.originator.source).toBe('ui');
    expect(own[0].request.originator.tabId).toBeTruthy();
    expect(own[0].request).not.toHaveProperty('basis');
    expect(hasUnsavedCanvasEdits()).toBe(true);

    await answer(0);
    expect(state().version).toBe(2);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(false);
    // The edit is not saved a second time as a whole-Space PUT.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('does not send selection, and keeps content fields on the content save', async () => {
    state().selectNodes([X]);
    state().updateNodeData(X, { content: 'typed here' });
    expect(own).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.putNodeContent).toHaveBeenCalled();
    expect(api.putCanvas).not.toHaveBeenCalled();

    // A patch that mixes both is sent without the content fields.
    state().updateNodeData(X, { label: 'Renamed', style: { accent: 'blue' } });
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([accentCommand(X, 'blue')]);
  });

  it('creates a node under the id this page already shows', async () => {
    state().addNode({
      nodeType: 'note',
      placementPoint: { x: 700, y: 700 },
      data: { content: 'New' },
    });
    const created = state().nodes.find((n) => n.id !== X && n.id !== Y);
    expect(created).toBeDefined();
    expect(created?.selected).toBe(true);
    const sent = own[0].request.commands[0] as Extract<
      CanvasCommand,
      { type: 'CREATE_NODES' }
    >;
    expect(sent.nodes[0].id).toBe(created?.id);
    expect(sent.nodes[0].selectOnCreate).toBe(false);

    await answer(0);
    expect(state().nodes.map((n) => n.id)).toEqual([X, Y, created?.id]);
    expect(server.state.nodes.map((n) => n.id)).toEqual([X, Y, created?.id]);
    // Still selected here, not selected on the server.
    expect(node(created?.id ?? '').selected).toBe(true);
    expect(serverNode(created?.id ?? '')?.selected).toBeUndefined();
    // The server wrote the first content; the page does not write it again.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('gives a drawn edge an id the server uses too', async () => {
    state().onConnect({
      source: X,
      target: Y,
      sourceHandle: null,
      targetHandle: null,
    });
    const [edge] = state().edges;
    expect(edge).toBeDefined();
    const sent = own[0].request.commands[0] as Extract<
      CanvasCommand,
      { type: 'CONNECT_NODES' }
    >;
    expect(sent.edges[0].id).toBe(edge.id);
    await answer(0);
    expect(state().edges.map((e) => e.id)).toEqual([edge.id]);
    expect(server.state.edges.map((e) => e.id)).toEqual([edge.id]);
  });
});

describe('receiving while a local change is in flight', () => {
  it('A moves X while B recolours X: both survive on both sides', async () => {
    state().selectNodes([Y]);
    moveHere(X, 500);
    // B's recolour is committed first, computed against X at the origin.
    expect(deliver(remote([accentCommand(X, 'blue')]), 'ui')).toBe(true);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
    expect(state().version).toBe(2);

    await answer(0);
    expect(state().version).toBe(3);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    expect(accentOf(serverNode(X) as Node)).toBe('blue');
    // B's edit did not touch this page's selection or its undo history
    // (one entry: this page's own move).
    expect(node(Y).selected).toBe(true);
    state().undo();
    expect(state().canUndo).toBe(false);
  });

  it('keeps the local value of a property both pages changed; the later local change wins everywhere', async () => {
    moveHere(X, 500);
    deliver(remote([moveCommand(X, 900)]), 'ui');
    // Held: B's position is not shown here.
    expect(node(X).position).toEqual({ x: 500, y: 0 });

    await answer(0);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
  });

  it('two consecutive moves of one node: the first echo does not pull it back', async () => {
    moveHere(X, 100);
    moveHere(X, 200);
    expect(own).toHaveLength(1); // the second waits its turn

    // The first move's update arrives on the stream before its HTTP answer.
    const first = commit(0);
    expect(deliver(first, 'ui')).toBe(true);
    expect(state().version).toBe(2);
    expect(node(X).position).toEqual({ x: 200, y: 0 });

    await answer(0, first);
    expect(node(X).position).toEqual({ x: 200, y: 0 });
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([moveCommand(X, 200)]);

    await answer(1);
    expect(state().version).toBe(3);
    expect(node(X).position).toEqual({ x: 200, y: 0 });
    expect(serverNode(X)?.position).toEqual({ x: 200, y: 0 });
  });

  it('applies the own update once, whichever of stream and HTTP answer comes first', async () => {
    moveHere(X, 100);
    const update = commit(0);
    await answer(0, update); // HTTP first: applied as the next version
    expect(state().version).toBe(2);
    // The same update then arrives on the stream and is stale.
    expect(deliver(update, 'ui')).toBe(false);
    expect(node(X).position).toEqual({ x: 100, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it('installs a withheld remote value when the local change ends as a no-op', async () => {
    recolourHere(X, 'red');
    deliver(remote([accentCommand(X, 'blue')]), 'ui');
    expect(accentOf(node(X))).toBe('red');

    // The server answers that this page's batch wrote nothing.
    await answer(0, {
      canvasId: SPACE,
      fromVersion: 2,
      toVersion: 2,
      deltas: [],
      results: [
        {
          command: own[0].request.commands[0],
          applied: false,
          reason: 'no-op',
        },
      ],
      commands: own[0].request.commands,
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    });
    expect(accentOf(node(X))).toBe('blue');
    expect(state().version).toBe(2);
    expect(toast).not.toHaveBeenCalled();
  });

  it('installs a withheld remote value, tells the user once and reloads when the change is rejected', async () => {
    recolourHere(X, 'red');
    recolourHere(Y, 'red');
    deliver(remote([accentCommand(X, 'blue')]), 'ui');
    expect(accentOf(node(X))).toBe('red');

    await answer(0, {
      canvasId: SPACE,
      fromVersion: 2,
      toVersion: 2,
      deltas: [],
      results: own[0].request.commands.map((command) => ({
        command,
        applied: false,
        reason: 'not-found',
      })),
      commands: own[0].request.commands,
      pendingEffects: {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      },
    });
    // X shows B's colour; nothing remote was withheld for Y, so it goes back
    // to the colour it had before the rejected change.
    expect(accentOf(node(X))).toBe('blue');
    expect(toast).toHaveBeenCalledTimes(1);
    // The other queued edit is unaffected and still sent.
    expect(own).toHaveLength(2);
    expect(api.getCanvas).not.toHaveBeenCalled();

    await answer(1);
    await flush();
    // With nothing left to send the page converges to the server's Space.
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(accentOf(node(Y))).toBe('red');
    expect(accentOf(serverNode(Y) as Node)).toBe('red');
  });

  it("applies another person's creation and deletion without selection or undo entries", async () => {
    state().selectNodes([Y]);
    const created = remote([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-remote',
            nodeType: 'note',
            position: { x: 900, y: 900 },
            data: { content: 'From B' },
          },
        ],
      },
    ]);
    deliver(created, 'ui');
    expect(state().nodes.map((n) => n.id)).toEqual([X, Y, 'node-remote']);
    expect(node('node-remote').selected).toBeFalsy();
    expect(node(Y).selected).toBe(true);
    expect(canvasHistoryManager.canUndo).toBe(false);

    deliver(
      remote([{ type: 'DELETE_NODES', nodeIds: [X as `node-${string}`] }]),
      'ui',
    );
    expect(state().nodes.map((n) => n.id)).toEqual([Y, 'node-remote']);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(state().version).toBe(3);
  });

  it("still takes an undo snapshot for an agent's batch", () => {
    const update = server.execute(SPACE, {
      commands: [moveCommand(X, 640)],
      originator: { source: 'agent' },
    });
    deliver(update, 'agent');
    expect(node(X).position).toEqual({ x: 640, y: 0 });
    expect(canvasHistoryManager.canUndo).toBe(true);
  });
});

describe('the whole-Space save and reload wait for the queue', () => {
  it('does not PUT while a batch is unanswered, then PUTs with the advanced version', async () => {
    moveHere(X, 500);
    // A writer that still saves through the whole-Space PUT.
    state().patchNodeSilent(Y, { pinned: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();

    await answer(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.putCanvas).toHaveBeenCalledTimes(1);
    expect(api.putCanvas.mock.calls[0][1].version).toBe(2);
  });

  it('holds a wanted reload until the queue has drained', async () => {
    moveHere(X, 500);
    const reloaded = vi.fn();
    requestCanvasResync(SPACE, reloaded);
    await flush();
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(node(X).position).toEqual({ x: 500, y: 0 });

    await answer(0);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(reloaded).toHaveBeenCalledTimes(1);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(state().version).toBe(2);
  });

  it('reloads at once when nothing is waiting to be sent', async () => {
    requestCanvasResync(SPACE);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
  });
});

describe('a free drag', () => {
  it('is sent at the drop as the geometry its ticks left in the store', async () => {
    const dragged = [node(X)];
    state().onNodeDragStart(new MouseEvent('mousedown'), dragged[0], dragged);
    state().onNodesChange([
      { type: 'position', id: X, position: { x: 240, y: 60 }, dragging: true },
    ]);
    // Ticks stay local.
    expect(own).toHaveLength(0);
    state().onNodesChange([
      { type: 'position', id: X, position: { x: 240, y: 60 }, dragging: false },
    ]);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);

    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([moveCommand(X, 240, 60)]);
    // B recolours X meanwhile: the drop is held, the colour lands.
    deliver(remote([accentCommand(X, 'blue')]), 'ui');
    expect(node(X).position).toEqual({ x: 240, y: 60 });
    expect(accentOf(node(X))).toBe('blue');

    await answer(0);
    expect(serverNode(X)?.position).toEqual({ x: 240, y: 60 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
    // One undo entry for the drag.
    state().undo();
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('sends nothing for a click that did not move the node', async () => {
    const dragged = [node(X)];
    state().onNodeDragStart(new MouseEvent('mousedown'), dragged[0], dragged);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(0);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});
