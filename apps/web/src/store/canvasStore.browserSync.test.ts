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

import {
  autoHeightKey,
  intrinsicToLayoutHeight,
  measuredSizeKey,
  type Delta,
} from '@huabu/shared/canvas-engine';

import { dismissToast, toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  drainPendingSaves,
  hasUnsavedCanvasEdits,
  requestCanvasResync,
  resetCanvasSyncForTests,
} from './canvasStore';
import { DEFAULT_SEND_RETRY } from './canvasStore/sync/sendQueue';
import { useCanvasSyncStatusStore } from './canvasStore/sync/syncStatus';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type {
  CanvasCommand,
  PostCanvasExecuteRequest,
  PostCanvasExecuteResponse,
} from '@huabu/shared';
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
  // A case may end inside a gesture; do not let its snapshot flag carry on.
  canvasHistoryManager.consumeGestureSnapshot();
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

describe('nothing saves the whole Space', () => {
  it('sends no whole-Space PUT after a command batch, a title change or a direct store write', async () => {
    moveHere(X, 500);
    useCanvasStore.setState({ canvasTitle: 'Renamed' });
    useCanvasStore.setState({
      nodes: state().nodes.map((n) =>
        n.id === Y ? { ...n, position: { x: 900, y: 900 } } : n,
      ),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await answer(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
    // Only the command reached the server.
    expect(own).toHaveLength(1);
    expect(serverNode(Y)?.position).not.toEqual({ x: 900, y: 900 });
  });

  it('does not flush a whole-Space PUT when the page closes', async () => {
    moveHere(X, 500);
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });
});

describe('a wanted reload waits for the queue', () => {
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

  const tick = (id: string, x: number, dragging = true) =>
    state().onNodesChange([
      { type: 'position', id, position: { x, y: 0 }, dragging },
    ]);

  it('keeps a node under the pointer where it is when another page moves it, and the drop wins', async () => {
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    tick(X, 150);
    deliver(remote([moveCommand(X, 900), accentCommand(X, 'blue')]), 'ui');
    // The colour lands; the position stays under the hand.
    expect(node(X).position).toEqual({ x: 150, y: 0 });
    expect(accentOf(node(X))).toBe('blue');

    tick(X, 200, false);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([moveCommand(X, 200)]);
    await answer(0);
    expect(serverNode(X)?.position).toEqual({ x: 200, y: 0 });
    expect(node(X).position).toEqual({ x: 200, y: 0 });
  });

  it('a cancelled drag goes back to where another page put the node meanwhile', async () => {
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    tick(X, 150);
    deliver(remote([moveCommand(X, 900)]), 'ui');
    expect(node(X).position).toEqual({ x: 150, y: 0 });

    state().cancelActiveNodeDrag();
    expect(node(X).position).toEqual({ x: 900, y: 0 });
    expect(own).toHaveLength(0);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('a batch sent in the middle of a gesture does not pull the node back or lose the rest of it', async () => {
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    tick(X, 100);
    // Something commits mid-gesture (a modifier key interrupting a resize
    // does this); the gesture goes on.
    state().setNodeGeometry([{ nodeId: X, position: { x: 100, y: 0 } }]);
    expect(own).toHaveLength(1);
    tick(X, 200);

    // The update for the mid-gesture batch arrives while the pointer is
    // still down.
    await answer(0);
    expect(serverNode(X)?.position).toEqual({ x: 100, y: 0 });
    expect(node(X).position).toEqual({ x: 200, y: 0 });

    tick(X, 260, false);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([moveCommand(X, 260)]);
    await answer(1);
    expect(serverNode(X)?.position).toEqual({ x: 260, y: 0 });
    expect(node(X).position).toEqual({ x: 260, y: 0 });
  });

  it('a gesture that ends without a command still sends what its ticks changed', async () => {
    state().onNodeResizeStart();
    state()._setStateNoAutosave({
      nodes: state().nodes.map((n) =>
        n.id === X ? { ...n, style: { width: 360, height: 200 } } : n,
      ),
    });
    expect(own).toHaveLength(0);
    state().closePointerGesture();
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      {
        type: 'SET_NODE_GEOMETRY',
        items: [{ nodeId: X, size: { width: 360, height: 200 } }],
      },
    ]);
    // Closing twice sends nothing more.
    state().closePointerGesture();
    expect(own).toHaveLength(1);
  });

  it('sends nothing for a click that did not move the node', async () => {
    const dragged = [node(X)];
    state().onNodeDragStart(new MouseEvent('mousedown'), dragged[0], dragged);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(0);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });
});

describe('when a change cannot be sent', () => {
  const offline = () => new TypeError('Failed to fetch');
  const syncState = () => useCanvasSyncStatusStore.getState().state;
  const notices = () =>
    vi.mocked(toast).mock.calls.map(([message, options]) => ({
      message,
      options,
    }));
  /** Fail the request on the wire and wait out the backoff before the next. */
  async function failOnce() {
    own.at(-1)?.reject(offline());
    await flush();
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_RETRY.maxDelayMs);
  }
  async function failUntilStalled() {
    for (let attempt = 0; attempt < DEFAULT_SEND_RETRY.maxAttempts; attempt++)
      await failOnce();
    expect(syncState()).toBe('error');
  }

  it('shows an unsynced state, retries the same request on its own and clears when it gets through', async () => {
    moveHere(X, 500);
    expect(syncState()).toBe('syncing');
    await failOnce();
    expect(syncState()).toBe('unsynced');
    expect(notices()).toHaveLength(1);
    expect(notices()[0].message).toMatch(/not synced yet/);
    // The edit stays on screen and the same request is sent again.
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(own).toHaveLength(2);
    expect(own[1].request).toEqual(own[0].request);

    await failOnce();
    // Still one notice, not one per attempt.
    expect(notices()).toHaveLength(1);

    await answer(own.length - 1);
    expect(syncState()).toBe('synced');
    expect(dismissToast).toHaveBeenCalledWith('toast-id');
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    // The server ran the batch once however often it was sent.
    expect(server.state.version).toBe(2);
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('enters an explicit error state after the retry limit and never reloads on its own', async () => {
    moveHere(X, 500);
    await failUntilStalled();
    const attempts = own.length;
    const error = notices().at(-1);
    expect(error?.message).toMatch(/could not be sent/);
    expect(error?.options).toMatchObject({
      duration: 0,
      dismissible: false,
      action: { label: 'Keep trying' },
      secondaryAction: { label: 'Reload and discard unsent changes' },
    });

    // Nothing more is sent, and a reload that becomes wanted is held.
    requestCanvasResync(SPACE);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(own).toHaveLength(attempts);
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(true);
    // Leaving the Space is refused while the change is unsent.
    await expect(drainPendingSaves(SPACE)).rejects.toThrow(/could not be sent/);
  });

  it('refuses to leave as soon as the request fails again, without waiting out the retry schedule', async () => {
    moveHere(X, 500);
    own[0].reject(new Error('offline'));
    await flush();
    expect(own).toHaveLength(1);

    const leaving = drainPendingSaves(SPACE);
    const refused = expect(leaving).rejects.toThrow(/could not be sent/);
    // The request is tried again at once rather than after the backoff.
    await flush();
    expect(own).toHaveLength(2);
    own[1].reject(new Error('offline'));
    await refused;
    // Nothing was given up: the edit is still waiting to be sent.
    expect(hasUnsavedCanvasEdits()).toBe(true);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
  });

  it('counts the attempts a drain makes towards the retry limit', async () => {
    moveHere(X, 500);
    own[0].reject(offline());
    await flush();
    // Leaving is tried again and again while the request keeps failing.
    for (let drain = 1; drain < DEFAULT_SEND_RETRY.maxAttempts; drain++) {
      const leaving = drainPendingSaves(SPACE);
      const refused = expect(leaving).rejects.toThrow(/could not be sent/);
      await flush();
      own.at(-1)?.reject(offline());
      await refused;
    }
    // The limit holds across drains: the page is in the error state now.
    expect(own).toHaveLength(DEFAULT_SEND_RETRY.maxAttempts);
    expect(syncState()).toBe('error');
    expect(notices().at(-1)?.options).toMatchObject({
      action: { label: 'Keep trying' },
    });
    // One more drain is refused without another request.
    await expect(drainPendingSaves(SPACE)).rejects.toThrow(/could not be sent/);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(own).toHaveLength(DEFAULT_SEND_RETRY.maxAttempts);

    // The user's "Keep trying" starts a fresh count.
    notices().at(-1)?.options?.action?.onClick();
    expect(own).toHaveLength(DEFAULT_SEND_RETRY.maxAttempts + 1);
    own.at(-1)?.reject(offline());
    await flush();
    expect(syncState()).toBe('unsynced');
  });

  it('counts the time a drain spends towards the retry time limit', async () => {
    moveHere(X, 500);
    own[0].reject(offline());
    await flush();
    await vi.advanceTimersByTimeAsync(DEFAULT_SEND_RETRY.maxElapsedMs);
    // The backoff sent the request again meanwhile; fail what is on the wire
    // through a drain, well past the time limit since the first failure.
    const leaving = drainPendingSaves(SPACE);
    const refused = expect(leaving).rejects.toThrow(/could not be sent/);
    await flush();
    own.at(-1)?.reject(offline());
    await refused;
    expect(syncState()).toBe('error');
  });

  it('lets the page leave once the retried request is answered', async () => {
    moveHere(X, 500);
    own[0].reject(new Error('offline'));
    await flush();
    const leaving = drainPendingSaves(SPACE);
    await flush();
    await answer(1);
    await expect(leaving).resolves.toBeUndefined();
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
  });

  it('"keep trying" sends the same request again', async () => {
    moveHere(X, 500);
    await failUntilStalled();
    const attempts = own.length;
    notices().at(-1)?.options?.action?.onClick();
    expect(own).toHaveLength(attempts + 1);
    expect(own.at(-1)?.request).toEqual(own[0].request);
    expect(syncState()).toBe('syncing');

    await answer(own.length - 1);
    expect(syncState()).toBe('synced');
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
  });

  it('"reload and discard" drops the unsent changes and shows the server\'s Space', async () => {
    moveHere(X, 500);
    recolourHere(Y, 'red');
    await failUntilStalled();
    notices().at(-1)?.options?.secondaryAction?.onClick();
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(accentOf(node(Y))).toBe('white');
    expect(syncState()).toBe('synced');
    expect(hasUnsavedCanvasEdits()).toBe(false);
    // Nothing of the discarded batches is sent afterwards.
    const attempts = own.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(own).toHaveLength(attempts);
  });

  it('retries at once when the browser comes back online, also from the error state', async () => {
    moveHere(X, 500);
    own[0].reject(offline());
    await flush();
    expect(own).toHaveLength(1);
    // Without waiting out the backoff.
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(own).toHaveLength(2);

    await failUntilStalled();
    const attempts = own.length;
    window.dispatchEvent(new Event('online'));
    expect(own).toHaveLength(attempts + 1);
    await answer(own.length - 1);
    expect(syncState()).toBe('synced');
  });

  it('warns before the page closes and flushes unsent batches with keepalive', async () => {
    moveHere(X, 500);
    moveHere(Y, 500, 300);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const flushed = api.postCanvasExecute.mock.calls.filter(
      ([, , options]) => options?.keepalive === true,
    );
    expect(flushed.map(([, request]) => request.operationId)).toEqual([
      own[0].request.operationId,
      // The second batch had not been sent yet; it goes out with its own id.
      expect.stringMatching(/^[0-9a-f-]{36}$/),
    ]);
    expect(flushed[1][1].commands).toEqual([moveCommand(Y, 500, 300)]);
  });

  it('does not warn when everything has been sent', async () => {
    moveHere(X, 500);
    await answer(0);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('undo and redo', () => {
  it("takes back this page's move and keeps what another page changed since", async () => {
    moveHere(X, 500);
    await answer(0);
    deliver(remote([accentCommand(X, 'blue'), moveCommand(Y, 40, 300)]), 'ui');
    expect(accentOf(node(X))).toBe('blue');

    state().undo();
    // Only the move is taken back.
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
    expect(node(Y).position).toEqual({ x: 40, y: 300 });
    // It is sent as the command that reproduces it.
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([moveCommand(X, 0)]);
    await answer(1);
    expect(serverNode(X)?.position).toEqual({ x: 0, y: 0 });
    expect(accentOf(serverNode(X) as Node)).toBe('blue');

    state().redo();
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
    expect(own[2].request.commands).toEqual([moveCommand(X, 500)]);
    await answer(2);
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });
});

describe('undo and redo beyond what commands can say', () => {
  it('records what a gesture changed even when its closing batch applies nothing', async () => {
    state().beginGesture('SET_NODE_GEOMETRY');
    // Live ticks put the node where the pointer is.
    state()._setStateNoAutosave({
      nodes: state().nodes.map((n) =>
        n.id === X ? { ...n, position: { x: 300, y: 0 } } : n,
      ),
    });
    // The batch that closes the gesture applies nothing itself.
    state().executeCommands([
      { type: 'DELETE_NODES', nodeIds: ['node-not-there'] },
    ]);
    expect(own[0].request.commands).toEqual([moveCommand(X, 300)]);
    await answer(0);
    deliver(remote([accentCommand(X, 'blue')]), 'ui');

    state().undo();
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
  });

  it('brings a deleted node back as itself with a command, and a later edit follows it in the queue', async () => {
    const original = node(X);
    state().deleteNodes([X]);
    await answer(0);
    expect(state().nodes.map((n) => n.id)).toEqual([Y]);
    expect(serverNode(X)).toBeUndefined();

    state().undo();
    expect(
      state()
        .nodes.map((n) => n.id)
        .sort(),
    ).toEqual([X, Y].sort());
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([
      {
        type: 'RESTORE_NODES',
        nodes: [expect.objectContaining({ id: X, data: original.data })],
      },
      // It comes back where it was in the paint order.
      { type: 'REORDER_NODES', nodeIds: [X], to: { before: Y } },
    ]);
    // A move made before the restore is answered goes out after it.
    moveHere(X, 700);
    await answer(1);
    expect(serverNode(X)?.data).toMatchObject(original.data);
    await vi.advanceTimersByTimeAsync(0);
    await answer(2);
    expect(serverNode(X)?.position).toEqual({ x: 700, y: 0 });
    expect(node(X).position).toEqual({ x: 700, y: 0 });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('sends a patch that clears a key as an explicit removal', async () => {
    state().updateNodeData(X, { pinned: true });
    await answer(0);
    expect(serverNode(X)?.data.pinned).toBe(true);
    // `undefined` does not survive JSON, so the removal is named.
    state().updateNodeData(X, { pinned: undefined });
    expect(node(X).data.pinned).toBeUndefined();
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: {}, unset: ['pinned'] }],
      },
    ]);
    await answer(1);
    expect(serverNode(X)?.data).not.toHaveProperty('pinned');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('undoes the first setting of a data key by removing it', async () => {
    state().updateNodeData(X, { pinned: true });
    await answer(0);
    state().undo();
    expect(node(X).data).not.toHaveProperty('pinned');
    expect(own[1].request.commands).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: {}, unset: ['pinned'] }],
      },
    ]);
    await answer(1);
    expect(serverNode(X)?.data).not.toHaveProperty('pinned');
  });
});

describe('writers that used to save only through the whole-Space PUT', () => {
  it('sends a silent structure patch as a command', async () => {
    state().patchNodeSilent(X, {
      style: { ...(node(X).data.style as object), fontSize: 22 },
    });
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: { style: { fontSize: 22 } } }],
      },
    ]);
    await answer(0);
    expect((serverNode(X)?.data.style as { fontSize?: number }).fontSize).toBe(
      22,
    );
    // Not an undo entry, and not a whole-Space save.
    expect(canvasHistoryManager.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('does not queue a silent patch of content fields or read-model hints', async () => {
    state().patchNodeSilent(X, { label: 'Generated', summary: 'S' });
    state().patchNodeSilent(X, { contentMissing: true });
    expect(own).toHaveLength(0);
    expect(node(X).data).toMatchObject({
      label: 'Generated',
      contentMissing: true,
    });
  });

  it('folds a silent patch made during a pointer gesture into the batch that closes it', async () => {
    state().beginGesture('SET_NODE_GEOMETRY');
    state().patchNodeSilent(X, { style: { accent: 'white', fontSize: 30 } });
    expect(own).toHaveLength(0);
    state().setNodeGeometry([{ nodeId: X, position: { x: 80, y: 0 } }]);
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: { style: { fontSize: 30 } } }],
      },
      moveCommand(X, 80),
    ]);
  });
});

describe('measured heights', () => {
  const AUTO = 'node-sync-auto';
  const autoNote = (): Node => ({
    id: AUTO,
    type: 'note',
    position: { x: 600, y: 0 },
    style: { width: 300, height: 120 },
    data: { type: 'note', content: 'Auto body', heightMode: 'auto' },
  });
  const measurement = (intrinsicHeight: number) => ({
    nodeId: AUTO as `node-${string}`,
    intrinsicHeight,
    measuredFor: autoHeightKey(node(AUTO)),
  });
  const layoutHeight = (intrinsicHeight: number) =>
    intrinsicToLayoutHeight(intrinsicHeight, 'note', 300);
  const heightOf = (value: Node | undefined) =>
    (value?.style as { height?: number } | undefined)?.height;

  beforeEach(() => {
    const nodes = [...state().nodes, autoNote()];
    state()._setStateNoAutosave({ nodes });
    server.reset(nodes, [], 1);
  });

  it('applies a measurement here at once and reports it once, without a whole-Space save', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      { type: 'APPLY_MEASURED_HEIGHT', items: [measurement(400)] },
    ]);
    expect(own[0].request.originator.source).toBe('ui');

    await answer(0);
    expect(heightOf(serverNode(AUTO))).toBe(layoutHeight(400));
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    // A measurement is not an undo entry.
    expect(canvasHistoryManager.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('does not report again for content the server already has a height for', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    await answer(0);
    // This page renders the same body a little taller.
    state().applyMeasuredHeights([measurement(420)]);
    expect(heightOf(node(AUTO))).toBe(layoutHeight(420));
    expect(own).toHaveLength(1);
    expect(heightOf(serverNode(AUTO))).toBe(layoutHeight(400));
  });

  it("does not report over another page's measurement of the same content", async () => {
    deliver(
      remote([{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement(400)] }]),
      'ui',
    );
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    state().applyMeasuredHeights([measurement(420)]);
    // Shown here, not written back: two pages would otherwise keep
    // rewriting each other's size.
    expect(heightOf(node(AUTO))).toBe(layoutHeight(420));
    expect(own).toHaveLength(0);
    expect(heightOf(serverNode(AUTO))).toBe(layoutHeight(400));
  });

  it('waits for the content save before reporting the height of an edited body', async () => {
    let saved!: () => void;
    api.putNodeContent.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = () => resolve({ nodeId: AUTO, label: null, rev: 'rev-2' });
        }),
    );
    state().updateNodeData(AUTO, { content: 'A much longer body' });
    state().applyMeasuredHeights([measurement(500)]);
    expect(heightOf(node(AUTO))).toBe(layoutHeight(500));
    // The server would refuse a height for a body it does not have yet.
    expect(own).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    saved();
    await flush();
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      { type: 'APPLY_MEASURED_HEIGHT', items: [measurement(500)] },
    ]);
  });

  it('keeps the measured height here when the server refuses the report', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    await answer(0, {
      canvasId: SPACE,
      fromVersion: 1,
      toVersion: 1,
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
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('a derived report is not an unsent edit', () => {
  const AUTO = 'node-sync-auto';
  const offline = () => new TypeError('Failed to fetch');
  const syncState = () => useCanvasSyncStatusStore.getState().state;
  const measurement = (intrinsicHeight: number) => ({
    nodeId: AUTO as `node-${string}`,
    intrinsicHeight,
    measuredFor: autoHeightKey(node(AUTO)),
  });
  const leave = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };
  const keepaliveRequests = () =>
    api.postCanvasExecute.mock.calls.filter(
      ([, , options]) => options?.keepalive === true,
    );

  beforeEach(() => {
    const nodes = [
      ...state().nodes,
      {
        id: AUTO,
        type: 'note',
        position: { x: 600, y: 0 },
        style: { width: 300, height: 120 },
        data: { type: 'note', content: 'Auto body', heightMode: 'auto' },
      } as Node,
    ];
    state()._setStateNoAutosave({ nodes });
    server.reset(nodes, [], 1);
  });

  it('does not ask before leaving for an unanswered measurement, and still flushes it', () => {
    state().applyMeasuredHeights([measurement(400)]);
    expect(own).toHaveLength(1);
    expect(leave().defaultPrevented).toBe(false);
    // Best effort: the report is still sent on the way out.
    expect(keepaliveRequests().map(([, request]) => request.commands)).toEqual([
      [{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement(400)] }],
    ]);
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it("asks before leaving when a user's edit waits behind a measurement", () => {
    state().applyMeasuredHeights([measurement(400)]);
    moveHere(X, 500);
    expect(leave().defaultPrevented).toBe(true);
    expect(keepaliveRequests()).toHaveLength(2);
    expect(hasUnsavedCanvasEdits()).toBe(true);
  });

  it('neither shows the unsynced notice nor refuses leaving while only a measurement fails', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    own[0].reject(offline());
    await flush();
    expect(syncState()).toBe('synced');
    expect(toast).not.toHaveBeenCalled();
    await expect(drainPendingSaves(SPACE)).resolves.toBeUndefined();
  });

  it('gives a measurement up at the retry limit without the error state, and reports it again later', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    for (let attempt = 0; attempt < DEFAULT_SEND_RETRY.maxAttempts; attempt++) {
      own.at(-1)?.reject(offline());
      await flush();
      await vi.advanceTimersByTimeAsync(DEFAULT_SEND_RETRY.maxDelayMs);
    }
    // The attempt or the time limit was reached: nothing more is sent.
    const attempts = own.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(own).toHaveLength(attempts);
    await expect(drainPendingSaves(SPACE)).resolves.toBeUndefined();
    expect(syncState()).toBe('synced');
    expect(toast).not.toHaveBeenCalled();
    // The page keeps what it measured.
    expect((node(AUTO).style as { height?: number } | undefined)?.height).toBe(
      intrinsicToLayoutHeight(400, 'note', 300),
    );
    // A user's edit made afterwards starts with its own attempts.
    moveHere(X, 500);
    expect(own).toHaveLength(attempts + 1);
    expect(syncState()).toBe('syncing');
    await answer(own.length - 1);
    // The height was not left marked as reported: the next measurement of
    // the same content goes out.
    state().applyMeasuredHeights([measurement(420)]);
    expect(own.at(-1)?.request.commands).toEqual([
      { type: 'APPLY_MEASURED_HEIGHT', items: [measurement(420)] },
    ]);
  });

  it("shows the unsynced notice and refuses leaving when a user's edit is stuck behind a failing measurement", async () => {
    state().applyMeasuredHeights([measurement(400)]);
    moveHere(X, 500);
    own[0].reject(offline());
    await flush();
    expect(syncState()).toBe('unsynced');
    const leaving = drainPendingSaves(SPACE);
    const refused = expect(leaving).rejects.toThrow(/could not be sent/);
    await flush();
    own.at(-1)?.reject(offline());
    await refused;
  });
});

describe('renderer-measured boxes', () => {
  const FRAME = 'node-sync-frame';
  const TEXT = 'node-sync-text';
  const frame = (): Node => ({
    id: FRAME,
    type: 'frame',
    position: { x: 1000, y: 0 },
    style: { width: 300, height: 200 },
    data: { type: 'frame', label: 'Frame', sizing: 'hug' },
  });
  const text = (data: Record<string, unknown> = {}): Node => ({
    id: TEXT,
    type: 'text',
    parentId: FRAME,
    position: { x: 20, y: 60 },
    style: { width: 200 },
    data: { type: 'text', content: 'A line', ...data },
  });
  const measure = (width: number, height: number) =>
    state().onNodesChange([
      { type: 'dimensions', id: TEXT, dimensions: { width, height } },
    ]);
  const item = (width: number, height: number) => ({
    nodeId: TEXT,
    width,
    height,
    measuredFor: measuredSizeKey(node(TEXT)),
  });
  const frameHeight = (value: Node | undefined) =>
    (value?.style as { height?: number } | undefined)?.height;

  function seed(textNode: Node = text()) {
    const nodes = [...state().nodes, frame(), textNode];
    state()._setStateNoAutosave({ nodes });
    server.reset(nodes, [], 1);
  }

  it('reports the box once and the server lays the Frame out around it, without a whole-Space save', async () => {
    seed();
    measure(200, 340);
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      { type: 'APPLY_MEASURED_SIZE', items: [item(200, 340)] },
    ]);
    // The same measurement again says nothing new.
    measure(200, 340);
    expect(own).toHaveLength(1);

    const local = frameHeight(node(FRAME));
    await answer(0);
    expect(serverNode(TEXT)?.data.measuredSize).toEqual({
      width: 200,
      height: 340,
      measuredFor: item(200, 340).measuredFor,
    });
    // The server ran the same layout this page did.
    expect(frameHeight(serverNode(FRAME))).toBe(local);
    expect(frameHeight(node(FRAME))).toBe(local);
    expect(canvasHistoryManager.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(own).toHaveLength(1);
    expect(api.putCanvas).not.toHaveBeenCalled();
  });

  it('says nothing when the server already holds this box for this content', async () => {
    const stored = text();
    seed({
      ...stored,
      data: {
        ...stored.data,
        measuredSize: {
          width: 200,
          height: 340,
          measuredFor: measuredSizeKey(stored),
        },
      },
    });
    // A pixel apart is the same box.
    measure(200, 341);
    expect(own).toHaveLength(0);
  });

  it('does not answer another page’s report with its own rendering of the same content', async () => {
    const stored = text();
    seed({
      ...stored,
      data: {
        ...stored.data,
        measuredSize: {
          width: 200,
          height: 340,
          measuredFor: measuredSizeKey(stored),
        },
      },
    });
    // This page renders the same body 12px taller. It lays its own Frame
    // out around that and leaves the stored box alone.
    measure(200, 352);
    expect(own).toHaveLength(0);
    expect(node(TEXT).measured).toMatchObject({ width: 200, height: 352 });
  });

  it('reports again when its own rendering of the same content changes', async () => {
    seed();
    measure(200, 340);
    await answer(0);
    // A larger font: same body, same width, another box.
    measure(200, 420);
    expect(own).toHaveLength(2);
    expect(own[1].request.commands).toEqual([
      { type: 'APPLY_MEASURED_SIZE', items: [item(200, 420)] },
    ]);
  });

  it('waits for the content save before reporting the box of an edited body', async () => {
    seed();
    let saved!: () => void;
    api.putNodeContent.mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = () => resolve({ nodeId: TEXT, label: null, rev: 'rev-2' });
        }),
    );
    state().updateNodeData(TEXT, { content: 'Two\nlines now' });
    measure(200, 380);
    // The server would ignore a box for a body it does not have yet.
    expect(own).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3_000);
    saved();
    await flush();
    expect(own).toHaveLength(1);
    expect(own[0].request.commands).toEqual([
      { type: 'APPLY_MEASURED_SIZE', items: [item(200, 380)] },
    ]);
  });

  it('keeps its layout and stays quiet when the server ignores the report', async () => {
    seed();
    measure(200, 340);
    const local = frameHeight(node(FRAME));
    await answer(0, {
      canvasId: SPACE,
      fromVersion: 1,
      toVersion: 1,
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
    expect(frameHeight(node(FRAME))).toBe(local);
    expect(toast).not.toHaveBeenCalled();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('does not report the box of a node whose size is authored', async () => {
    state().onNodesChange([
      { type: 'dimensions', id: X, dimensions: { width: 300, height: 180 } },
    ]);
    expect(own).toHaveLength(0);
  });
});
