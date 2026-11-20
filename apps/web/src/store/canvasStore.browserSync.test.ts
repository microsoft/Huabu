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

import { encodeBasis } from '@huabu/shared';
import {
  autoHeightKey,
  intrinsicToLayoutHeight,
  measuredSizeKey,
  type Delta,
} from '@huabu/shared/canvas-engine';

import { dismissToast, toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';

import { canvasHistoryManager } from './canvasHistoryManager';
import { useCanvasPresenceStore } from './canvasPresence/canvasPresenceStore';
import useCanvasStore, {
  drainPendingSaves,
  hasUnsavedCanvasEdits,
  requestCanvasResync,
  resetCanvasSyncForTests,
  setCanvasSyncLineageForTests,
} from './canvasStore';
import { ECHO_TIMEOUT_MS, RELOAD_RETRY } from './canvasStore/sync/browserSync';
import { DEFAULT_SEND_RETRY } from './canvasStore/sync/sendQueue';
import { useCanvasSyncStatusStore } from './canvasStore/sync/syncStatus';
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
  current.applyServerDeltas(
    update.deltas as Delta[],
    update.toVersion,
    update.pendingEffects as Parameters<typeof current.applyServerDeltas>[2],
    false,
    { events: update.orderEvents },
    {
      ...(update.operationId ? { operationId: update.operationId } : {}),
      source,
      ...(update.nodeContentRevisions
        ? { nodeContentRevisions: update.nodeContentRevisions }
        : {}),
    },
  );
  return true;
}
/** Another page (or an agent) writes; the server commits it at once. */
function remote(commands: CanvasCommand[]): PostCanvasExecuteResponse {
  return server.execute(SPACE, {
    operationId: crypto.randomUUID(),
    originator: { tabId: 'page-b' },
    edits: [{ commands }],
  });
}
/** A request's commands in order, across its edits. */
const commandsOf = (request: PostCanvasExecuteRequest): unknown[] =>
  request.edits.flatMap((edit) => edit.commands);
/** What each edit of a request says it was made on: `basis` and `after`. */
const readsOf = (request: PostCanvasExecuteRequest) =>
  request.edits.map(({ commands: _commands, ...read }) => read);
/** An answer in which the server wrote nothing. */
function unchanged(
  version: number,
  edits: PostCanvasExecuteResponse['edits'],
): PostCanvasExecuteResponse {
  return {
    canvasId: SPACE,
    fromVersion: version,
    toVersion: version,
    deltas: [],
    edits,
    pendingEffects: {
      mutatedNodeIds: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    },
  };
}
/** One edit of one command that the engine answered as a no-op. */
const NO_OP_EDIT: PostCanvasExecuteResponse['edits'] = [
  { applied: true, results: [{ applied: false, reason: 'no-op' }] },
];
/** The server stores a body a page saved through the content request. */
function saveOnServer(nodeId: string, content: string) {
  const { nodes, edges, version } = server.state;
  server.reset(
    nodes.map((candidate) =>
      candidate.id === nodeId
        ? { ...candidate, data: { ...candidate.data, content } }
        : candidate,
    ),
    edges,
    version,
  );
}

/** The read version a page that has applied `version` quotes. */
const basisAt = (version: number) => encodeBasis(FAKE_LINEAGE, version);

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
  setCanvasSyncLineageForTests(SPACE, FAKE_LINEAGE);
  own = [];
  const nodes = [note(X, 0, 0), note(Y, 0, 300)];
  server.reset(nodes, [], 1);
  canvasHistoryManager.activate(SPACE, true);
  state()._setStateRaw({
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
  api.getCanvas.mockImplementation(async (canvasId: string) => ({
    canvasId,
    title: 'Sync',
    version: server.state.version,
    basis: server.basis(),
    state: { nodes: server.state.nodes, edges: server.state.edges },
  }));
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
  it('takes effect at once and is sent with a request id and the read version it was made on', async () => {
    moveHere(X, 500);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 500)]);
    expect(own[0].request.operationId).toMatch(/^[0-9a-f-]{36}$/);
    // The page says which page it is, not what kind of writer it is.
    expect(own[0].request.originator).toEqual({
      tabId: expect.stringMatching(/.+/),
    });
    // One edit per batch, quoting the version this page had applied; the
    // request is its edits and nothing beside them.
    expect(own[0].request).not.toHaveProperty('basis');
    expect(own[0].request).not.toHaveProperty('commands');
    expect(own[0].request).not.toHaveProperty('runs');
    expect(own[0].request.edits).toEqual([
      { basis: basisAt(1), commands: [moveCommand(X, 500)] },
    ]);
    expect(hasUnsavedCanvasEdits()).toBe(true);

    await answer(0);
    expect(state().version).toBe(2);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(false);
    // The edit is not saved a second time as a whole-Space PUT.
    await vi.advanceTimersByTimeAsync(3_000);
  });

  it('does not send selection, and keeps content fields on the content save', async () => {
    state().selectNodes([X]);
    state().updateNodeData(X, { content: 'typed here' });
    expect(own).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.putNodeContent).toHaveBeenCalled();

    // A patch that mixes both is sent without the content fields.
    state().updateNodeData(X, { label: 'Renamed', style: { accent: 'blue' } });
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([accentCommand(X, 'blue')]);
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
    const sent = commandsOf(own[0].request)[0] as Extract<
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
    const sent = commandsOf(own[0].request)[0] as Extract<
      CanvasCommand,
      { type: 'CONNECT_NODES' }
    >;
    expect(sent.edges[0].id).toBe(edge.id);
    await answer(0);
    expect(state().edges.map((e) => e.id)).toEqual([edge.id]);
    expect(server.state.edges.map((e) => e.id)).toEqual([edge.id]);
  });
});

describe('a gesture is one edit here as on the server', () => {
  it('deletes two connected nodes together with the selected edge between them', async () => {
    state().onConnect({
      source: X,
      target: Y,
      sourceHandle: null,
      targetHandle: null,
    });
    await answer(0);
    const [edge] = state().edges;
    vi.mocked(toast).mockClear();

    // What the Delete key does with both nodes and the edge selected.
    state().deleteNodes([X, Y], [edge.id]);
    expect(state().nodes).toEqual([]);
    expect(state().edges).toEqual([]);
    expect(own).toHaveLength(2);
    expect(own[1].request.edits).toHaveLength(1);

    const response = commit(1);
    expect(response.edits).toEqual([
      expect.objectContaining({ applied: true }),
    ]);
    await answer(1, response);
    await flush();
    expect(server.state.nodes).toEqual([]);
    expect(server.state.edges).toEqual([]);
    expect(state().nodes).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  it('also removes a selected edge the deletion leaves in place', async () => {
    const Z = 'node-sync-z';
    state()._setStateRaw({ nodes: [...state().nodes, note(Z, 400, 0)] });
    server.reset(state().nodes, [], 1);
    state().onConnect({
      source: Y,
      target: Z,
      sourceHandle: null,
      targetHandle: null,
    });
    await answer(0);
    const [edge] = state().edges;

    state().deleteNodes([X], [edge.id]);
    await answer(1);
    expect(state().nodes.map((n) => n.id)).toEqual([Y, Z]);
    expect(state().edges).toEqual([]);
    expect(server.state.nodes.map((n) => n.id)).toEqual([Y, Z]);
    expect(server.state.edges).toEqual([]);
  });

  it('applies nothing and sends nothing when one command of the gesture is refused', async () => {
    state().executeCommands([
      accentCommand(X, 'red'),
      {
        type: 'DISCONNECT_EDGES',
        edges: ['edge-not-there' as `edge-${string}`],
      },
    ]);
    // The server would refuse the whole edit; the page does the same.
    expect(accentOf(node(X))).toBe('white');
    expect(own).toHaveLength(0);
    expect(state().canUndo).toBe(false);
  });

  // A target that is gone is not something the person can act on.
  it('says nothing about a refused gesture whose target no longer exists', () => {
    state().executeCommands([
      accentCommand(X, 'red'),
      {
        type: 'DISCONNECT_EDGES',
        edges: ['edge-not-there' as `edge-${string}`],
      },
    ]);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe('a gesture the engine refuses tells the person once and leaves nothing', () => {
  const OUTER = 'node-sync-outer';
  const INNER = 'node-sync-inner';
  const frame = (
    id: string,
    position: { x: number; y: number },
    size: number,
    data: Record<string, unknown> = {},
    parentId?: string,
  ): Node => ({
    id,
    type: 'frame',
    position,
    style: { width: size, height: size },
    ...(parentId ? { parentId } : {}),
    data: { type: 'frame', label: id, ...data },
  });
  const locked = (value: Node): Node => ({
    ...value,
    draggable: false,
    data: { ...value.data, locked: true },
  });
  /** A Frame at (1100, 100) inside a locked Frame, and X outside both. */
  const underLockedFrame = (inner: Record<string, unknown> = {}): Node[] => [
    locked(frame(OUTER, { x: 1000, y: 0 }, 800)),
    frame(INNER, { x: 100, y: 100 }, 600, inner, OUTER),
    note(X, 0, 0),
  ];
  function open(nodes: Node[]) {
    state()._setStateRaw({ nodes });
    server.reset(nodes, [], 1);
    return nodes;
  }
  /** Nothing changed here, nothing was sent, nothing can be undone. */
  function expectUntouched(nodes: Node[]) {
    expect(state().nodes).toBe(nodes);
    expect(own).toHaveLength(0);
    expect(state().canUndo).toBe(false);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(hasUnsavedCanvasEdits()).toBe(false);
  }
  const hints = () => vi.mocked(toast).mock.calls;
  // One attempt is told once, so each case is an attempt of its own day.
  let day = 0;
  beforeEach(() => {
    vi.setSystemTime(new Date(2030, 0, ++day));
  });

  it('grouping a selection that contains a locked node', () => {
    const nodes = open([
      { ...locked(note(X, 0, 0)), selected: true },
      { ...note(Y, 0, 300), selected: true },
    ]);
    state().frameSelectedNodes();
    expectUntouched(nodes);
    expect(hints()).toEqual([
      [i18n.t('canvasGesture.lockedGroup'), { tone: 'warning' }],
    ]);

    // The key held down, or pressed again at once, is the same attempt.
    state().frameSelectedNodes();
    expect(toast).toHaveBeenCalledTimes(1);
    // A later attempt is told again.
    vi.advanceTimersByTime(2_000);
    state().frameSelectedNodes();
    expect(toast).toHaveBeenCalledTimes(2);
    expectUntouched(nodes);
  });

  it('drawing a Frame around a locked node', () => {
    const nodes = open([locked(note(X, 0, 0)), note(Y, 0, 300)]);
    state().frameNodesInRect({ x: -50, y: -50, width: 500, height: 700 });
    expectUntouched(nodes);
    expect(hints()).toEqual([
      [i18n.t('canvasGesture.lockedGroup'), { tone: 'warning' }],
    ]);
  });

  it('dropping a node into a Frame inside a locked Frame puts it back where the drag began', () => {
    const nodes = open(underLockedFrame());
    // Cmd/Ctrl held: the drop may enter a nested Frame.
    state().onNodeDragStart(
      new MouseEvent('mousedown', { metaKey: true }),
      node(X),
      [node(X)],
    );
    const drop = { x: 1250, y: 250 };
    state().onNodesChange([
      { type: 'position', id: X, position: drop, dragging: true },
    ]);
    // A tick is not a gesture: nothing is said while the node is moving.
    expect(toast).not.toHaveBeenCalled();
    state().onNodesChange([
      { type: 'position', id: X, position: drop, dragging: false },
    ]);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);

    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(node(X).parentId).toBeUndefined();
    expect(node(X).dragging).toBeFalsy();
    expect(state().nodes.map(({ id }) => id)).toEqual(
      nodes.map(({ id }) => id),
    );
    expect(own).toHaveLength(0);
    expect(state().canUndo).toBe(false);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(hasUnsavedCanvasEdits()).toBe(false);
    expect(hints()).toEqual([
      [i18n.t('canvasGesture.locked'), { tone: 'warning' }],
    ]);

    // The next drag is an ordinary one.
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    state().onNodesChange([
      { type: 'position', id: X, position: { x: 40, y: 0 }, dragging: false },
    ]);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 40)]);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('adding a node on a grid Frame inside a locked Frame', () => {
    const nodes = open(underLockedFrame({ layoutMode: 'grid', gridCount: 2 }));
    state().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [
        {
          nodeType: 'note',
          placementPoint: { x: 1300, y: 300 },
          data: { label: 'New', content: '' },
        },
      ],
    });
    expectUntouched(nodes);
    expect(hints()).toEqual([
      [i18n.t('canvasGesture.locked'), { tone: 'warning' }],
    ]);
  });

  it('uses the general wording when no lock is involved', () => {
    const nodes = open([note(X, 0, 0), note(Y, 0, 300)]);
    state().executeCommands([
      accentCommand(X, 'red'),
      {
        type: 'SET_NODE_PARENT',
        nodeIds: [X as `node-${string}`],
        parentId: 'node-not-there',
      },
    ]);
    expectUntouched(nodes);
    expect(hints()).toEqual([
      [i18n.t('canvasGesture.refused'), { tone: 'warning' }],
    ]);
  });

  it('says nothing for a preview tick', () => {
    const nodes = open([locked(note(X, 0, 0)), note(Y, 0, 300)]);
    state().executeCommands(
      [
        {
          type: 'SET_NODE_PARENT',
          nodeIds: [X as `node-${string}`],
          parentId: null,
        },
        {
          type: 'SET_NODE_PARENT',
          nodeIds: [X as `node-${string}`],
          parentId: 'node-not-there',
        },
      ],
      'ui',
      { localOnly: true },
    );
    expect(state().nodes).toBe(nodes);
    expect(toast).not.toHaveBeenCalled();
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
    expect(commandsOf(own[1].request)).toEqual([moveCommand(X, 200)]);

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
    await answer(0, unchanged(2, NO_OP_EDIT));
    expect(accentOf(node(X))).toBe('blue');
    expect(state().version).toBe(2);
    expect(toast).not.toHaveBeenCalled();
  });

  it('installs a withheld remote value, tells the user once and reloads when the change is rejected', async () => {
    recolourHere(X, 'red');
    recolourHere(Y, 'red');
    deliver(remote([accentCommand(X, 'blue')]), 'ui');
    expect(accentOf(node(X))).toBe('red');

    await answer(
      0,
      unchanged(
        2,
        own[0].request.edits.map((edit) => ({
          applied: false,
          reason: 'not-found',
          failedAt: 0,
          results: edit.commands.map(() => ({
            applied: false,
            reason: 'not-found',
          })),
        })),
      ),
    );
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
    // The fake server has no credentials; who wrote the batch is what the
    // `update` event says, which is all a page ever sees of it.
    const update = server.execute(SPACE, {
      edits: [{ commands: [moveCommand(X, 640)] }],
    });
    deliver(update, 'agent');
    expect(node(X).position).toEqual({ x: 640, y: 0 });
    expect(canvasHistoryManager.canUndo).toBe(true);
  });
});

describe('nothing saves the whole Space', () => {
  // The API client has no whole-Space save any more; this watches the wire
  // for a request made around it.
  const wholeSpacePuts = (fetchSpy: { mock: { calls: unknown[][] } }) =>
    fetchSpy.mock.calls.filter(
      ([url, init]) =>
        (init as RequestInit | undefined)?.method === 'PUT' &&
        /\/canvas\/[^/]+$/.test(String(url)),
    );

  it('sends no whole-Space PUT after a command batch, a title change or a direct store write', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in this test'));
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
    expect(wholeSpacePuts(fetchSpy)).toEqual([]);
    // Only the command reached the server.
    expect(own).toHaveLength(1);
    expect(serverNode(Y)?.position).not.toEqual({ x: 900, y: 900 });
    fetchSpy.mockRestore();
  });

  it('does not flush a whole-Space PUT when the page closes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in this test'));
    moveHere(X, 500);
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wholeSpacePuts(fetchSpy)).toEqual([]);
    fetchSpy.mockRestore();
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

describe('a wanted reload waits for unsaved note text', () => {
  const waitingNotices = () =>
    vi
      .mocked(toast)
      .mock.calls.filter(([message]) => /newer changes/i.test(String(message)));

  it('runs by itself once the text has been saved, without the text being lost', async () => {
    api.putNodeContent.mockImplementation(
      async (
        _canvasId: string,
        nodeId: string,
        request: { content?: string },
      ) => {
        saveOnServer(nodeId, request.content ?? '');
        return { nodeId, label: null, rev: 'rev-saved' };
      },
    );
    state().updateNodeData(Y, { content: 'Being typed' });
    const reloaded = vi.fn();
    // A version gap, a snapshot that does not match, a rejected command.
    requestCanvasResync(SPACE, reloaded);
    await flush();
    // Not over text that is not saved yet.
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(node(Y).data.content).toBe('Being typed');

    // The debounced save goes out and is acknowledged; nothing else happens.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(reloaded).toHaveBeenCalledTimes(1);
    expect(node(Y).data.content).toBe('Being typed');
    expect(waitingNotices()).toHaveLength(0);
  });

  it('says what it is waiting for when the text cannot be saved, and runs once it has been', async () => {
    api.putNodeContent.mockRejectedValue(new TypeError('Failed to fetch'));
    state().updateNodeData(Y, { content: 'Cannot be saved yet' });
    requestCanvasResync(SPACE);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(node(Y).data.content).toBe('Cannot be saved yet');
    expect(waitingNotices()).toHaveLength(1);
    expect(String(waitingNotices()[0][0])).toContain(`Label ${Y}`);
    // One notice, however long it waits.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(waitingNotices()).toHaveLength(1);

    // The save gets through (the user's Retry, or the next drain).
    api.putNodeContent.mockImplementation(
      async (
        _canvasId: string,
        nodeId: string,
        request: { content?: string },
      ) => {
        saveOnServer(nodeId, request.content ?? '');
        return { nodeId, label: null, rev: 'rev-saved' };
      },
    );
    await drainPendingSaves(SPACE).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(node(Y).data.content).toBe('Cannot be saved yet');
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
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 240, 60)]);
    // B recolours X meanwhile: the drop is held, the colour lands.
    deliver(remote([accentCommand(X, 'blue')]), 'ui');
    expect(node(X).position).toEqual({ x: 240, y: 60 });
    expect(accentOf(node(X))).toBe('blue');

    await answer(0);
    expect(serverNode(X)?.position).toEqual({ x: 240, y: 60 });
    await vi.advanceTimersByTimeAsync(3_000);
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
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 200)]);
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
    expect(commandsOf(own[1].request)).toEqual([moveCommand(X, 260)]);
    await answer(1);
    expect(serverNode(X)?.position).toEqual({ x: 260, y: 0 });
    expect(node(X).position).toEqual({ x: 260, y: 0 });
  });

  it('a gesture that ends without a command still sends what its ticks changed', async () => {
    state().onNodeResizeStart();
    state()._setStateRaw({
      nodes: state().nodes.map((n) =>
        n.id === X ? { ...n, style: { width: 360, height: 200 } } : n,
      ),
    });
    expect(own).toHaveLength(0);
    state().closePointerGesture();
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([
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

  describe('"reload and discard" with unsaved note text', () => {
    const contentSaves = () =>
      api.putNodeContent.mock.calls.map((call) => ({
        nodeId: call[1] as string,
        content: (call[2] as { content?: string }).content,
      }));
    const clickReloadAndDiscard = () =>
      notices()
        .filter((notice) => /could not be sent/.test(String(notice.message)))
        .at(-1)
        ?.options?.secondaryAction?.onClick();
    const confirmation = () =>
      notices()
        .filter((notice) => /could not be saved/.test(String(notice.message)))
        .at(-1);

    it('saves the text first, then reloads: the body survives and the unsent move is gone', async () => {
      moveHere(X, 500);
      await failUntilStalled();
      // Typed just now: not saved yet.
      state().updateNodeData(Y, { content: 'Typed and not saved yet' });
      // The body is saved by its own request, which gets through.
      api.putNodeContent.mockImplementation(
        async (
          _canvasId: string,
          nodeId: string,
          request: { content?: string },
        ) => {
          saveOnServer(nodeId, request.content ?? '');
          return { nodeId, label: null, rev: 'rev-saved' };
        },
      );

      clickReloadAndDiscard();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(contentSaves()).toContainEqual({
        nodeId: Y,
        content: 'Typed and not saved yet',
      });
      expect(api.getCanvas).toHaveBeenCalledTimes(1);
      expect(node(X).position).toEqual({ x: 0, y: 0 });
      expect(node(Y).data.content).toBe('Typed and not saved yet');
      expect(syncState()).toBe('synced');
      expect(hasUnsavedCanvasEdits()).toBe(false);
      // No question was asked: nothing typed was at risk.
      expect(confirmation()).toBeUndefined();
      // The outcome is said.
      expect(notices().at(-1)?.message).toMatch(/reloaded/i);
    });

    it('names the note whose text cannot be saved and asks before discarding it; cancelling keeps everything', async () => {
      moveHere(X, 500);
      await failUntilStalled();
      state().updateNodeData(Y, { content: 'Only here' });
      api.putNodeContent.mockRejectedValue(offline());

      clickReloadAndDiscard();
      await vi.advanceTimersByTimeAsync(10_000);

      // Not reloaded, not silent: the note is named and the user is asked.
      expect(api.getCanvas).not.toHaveBeenCalled();
      const asked = confirmation();
      expect(asked?.message).toContain(`Label ${Y}`);
      expect(asked?.options).toMatchObject({
        duration: 0,
        dismissible: false,
        action: { label: 'Cancel' },
        secondaryAction: { label: 'Discard this text and reload' },
      });

      // Cancel: the text and the unsent move are still here, and so is the
      // choice the user started from.
      const before = notices().length;
      asked?.options?.action?.onClick();
      await flush();
      expect(api.getCanvas).not.toHaveBeenCalled();
      expect(node(Y).data.content).toBe('Only here');
      expect(node(X).position).toEqual({ x: 500, y: 0 });
      expect(syncState()).toBe('error');
      expect(hasUnsavedCanvasEdits()).toBe(true);
      const again = notices().slice(before).at(-1);
      expect(again?.message).toMatch(/could not be sent/);
      expect(again?.options).toMatchObject({
        secondaryAction: { label: 'Reload and discard unsent changes' },
      });
    });

    it('discards the text and reloads once the user confirms', async () => {
      moveHere(X, 500);
      await failUntilStalled();
      state().updateNodeData(Y, { content: 'Only here' });
      api.putNodeContent.mockRejectedValue(offline());

      clickReloadAndDiscard();
      await vi.advanceTimersByTimeAsync(10_000);
      const savesBefore = api.putNodeContent.mock.calls.length;
      confirmation()?.options?.secondaryAction?.onClick();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(api.getCanvas).toHaveBeenCalledTimes(1);
      expect(node(Y).data.content).toBe(`Body ${Y}`);
      expect(node(X).position).toEqual({ x: 0, y: 0 });
      expect(syncState()).toBe('synced');
      expect(hasUnsavedCanvasEdits()).toBe(false);
      expect(notices().at(-1)?.message).toMatch(/reloaded/i);
      // The discarded text is not sent afterwards.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(api.putNodeContent.mock.calls.length).toBe(savesBefore);
    });
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
    expect(commandsOf(flushed[1][1])).toEqual([moveCommand(Y, 500, 300)]);
  });

  it('fixes a request when it is first sent: the page-close flush is repeated as it was, and a later edit goes out in a request of its own', async () => {
    moveHere(X, 500);
    // Made on top of the unanswered move; waits its turn.
    moveHere(X, 600);
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    const flushed = api.postCanvasExecute.mock.calls
      .filter(([, , options]) => options?.keepalive === true)
      .map(([, request]) => structuredClone(request));
    expect(flushed).toHaveLength(2);
    expect(flushed[0]).toEqual(own[0].request);
    expect(flushed[1].edits).toEqual([
      {
        basis: basisAt(1),
        after: [{ operationId: own[0].request.operationId, edit: 0 }],
        commands: [moveCommand(X, 600)],
      },
    ]);

    // The page stayed open, and the user goes on.
    const sends = own.length;
    moveHere(X, 700);
    await answer(0);
    // The second request goes out exactly as the flush sent it, although
    // the first is known to have taken effect by now.
    expect(own).toHaveLength(sends + 1);
    expect(JSON.stringify(own[sends].request)).toBe(JSON.stringify(flushed[1]));
    await answer(sends);
    expect(commit(sends).edits.map((edit) => edit.applied)).toEqual([true]);
    // The edit made after the flush was not folded into it.
    expect(own).toHaveLength(sends + 2);
    expect(own[sends + 1].request.operationId).not.toBe(flushed[1].operationId);
    expect(commandsOf(own[sends + 1].request)).toEqual([moveCommand(X, 700)]);
    await answer(sends + 1);
    expect(serverNode(X)?.position).toEqual({ x: 700, y: 0 });
    expect(node(X).position).toEqual({ x: 700, y: 0 });
    expect(api.getCanvas).not.toHaveBeenCalled();
  });

  describe('a repeat the server answers from its stored outcome', () => {
    /** The server ran the request; its answer was lost and the repeat is answered. */
    async function answeredByReplay() {
      moveHere(X, 500);
      const first = commit(0);
      expect(server.state.version).toBe(2);
      await failOnce();
      expect(own).toHaveLength(2);
      expect(own[1].request).toEqual(own[0].request);
      const replay = commit(1);
      expect(replay.replayed).toBe(true);
      expect(replay).not.toHaveProperty('deltas');
      expect(replay.edits).toEqual(first.edits);
      expect([replay.fromVersion, replay.toVersion]).toEqual([1, 2]);
      await answer(1, replay);
      // The server ran the batch once.
      expect(server.state.version).toBe(2);
      return first;
    }

    it('is not applied as an update; the page converges with the update on the stream', async () => {
      const first = await answeredByReplay();
      // Nothing to apply: the page is where it was, showing its own move.
      expect(state().version).toBe(1);
      expect(node(X).position).toEqual({ x: 500, y: 0 });
      expect(syncState()).toBe('synced');

      expect(deliver(first, 'ui')).toBe(true);
      expect(state().version).toBe(2);
      expect(node(X).position).toEqual({ x: 500, y: 0 });
      expect(hasUnsavedCanvasEdits()).toBe(false);
      await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS * 2);
      expect(api.getCanvas).not.toHaveBeenCalled();
      // The move is still this page's to undo.
      state().undo();
      expect(node(X).position).toEqual({ x: 0, y: 0 });
    });

    it('loads the Space when the update does not arrive either', async () => {
      await answeredByReplay();
      await vi.advanceTimersByTimeAsync(ECHO_TIMEOUT_MS - 1);
      expect(api.getCanvas).not.toHaveBeenCalled();
      expect(state().version).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(api.getCanvas).toHaveBeenCalledTimes(1);
      expect(state().version).toBe(2);
      expect(node(X).position).toEqual({ x: 500, y: 0 });
    });
  });

  it('does not warn when everything has been sent', async () => {
    moveHere(X, 500);
    await answer(0);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('a read version the server does not know', () => {
  const OTHER = '00000000-0000-4000-8000-000000000002';
  /** The server refuses this page's `index`-th request as a whole. */
  async function refuse(index: number) {
    let error: unknown;
    try {
      commit(index);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({ status: 409, code: 'basis-unknown' });
    own[index].reject(error);
    await flush();
  }

  it('tells the user once, drops what was queued behind it and loads the Space, whose read versions are then accepted', async () => {
    // As after the Space was given a new history behind this page's back.
    setCanvasSyncLineageForTests(SPACE, OTHER);
    moveHere(X, 500);
    recolourHere(Y, 'red');
    await refuse(0);
    expect(toast).toHaveBeenCalledTimes(1);
    // The queued recolour was made on the same unknown history: not sent.
    expect(own).toHaveLength(1);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(false);

    moveHere(X, 700);
    expect(own[1].request.edits[0]?.basis).toBe(basisAt(1));
    await answer(1);
    expect(serverNode(X)?.position).toEqual({ x: 700, y: 0 });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
  });

  it('does not load again for a lineage it has just loaded', async () => {
    api.getCanvas.mockImplementation(async (canvasId: string) => ({
      canvasId,
      title: 'Sync',
      version: server.state.version,
      basis: encodeBasis(OTHER, server.state.version),
      state: { nodes: server.state.nodes, edges: server.state.edges },
    }));
    setCanvasSyncLineageForTests(SPACE, OTHER);
    moveHere(X, 500);
    await refuse(0);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    moveHere(X, 600);
    recolourHere(Y, 'red');
    await refuse(1);
    await vi.advanceTimersByTimeAsync(10_000);
    // Told again, but no reload loop.
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(own).toHaveLength(2);
    // Nothing is left pending or shown that the server does not have.
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(accentOf(node(Y))).toBe('white');
    expect(hasUnsavedCanvasEdits()).toBe(false);
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
    expect(commandsOf(own[1].request)).toEqual([moveCommand(X, 0)]);
    await answer(1);
    expect(serverNode(X)?.position).toEqual({ x: 0, y: 0 });
    expect(accentOf(serverNode(X) as Node)).toBe('blue');

    state().redo();
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(accentOf(node(X))).toBe('blue');
    expect(commandsOf(own[2].request)).toEqual([moveCommand(X, 500)]);
    await answer(2);
    expect(serverNode(X)?.position).toEqual({ x: 500, y: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe('undo and redo beyond what commands can say', () => {
  it('records what a gesture changed even when its closing batch applies nothing', async () => {
    state().beginGesture('SET_NODE_GEOMETRY');
    // Live ticks put the node where the pointer is.
    state()._setStateRaw({
      nodes: state().nodes.map((n) =>
        n.id === X ? { ...n, position: { x: 300, y: 0 } } : n,
      ),
    });
    // The batch that closes the gesture applies nothing itself.
    state().executeCommands([
      { type: 'DELETE_NODES', nodeIds: ['node-not-there'] },
    ]);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 300)]);
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
    expect(commandsOf(own[1].request)).toEqual([
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
  });

  it('sends a patch that clears a key as an explicit removal', async () => {
    state().updateNodeData(X, { pinned: true });
    await answer(0);
    expect(serverNode(X)?.data.pinned).toBe(true);
    // `undefined` does not survive JSON, so the removal is named.
    state().updateNodeData(X, { pinned: undefined });
    expect(node(X).data.pinned).toBeUndefined();
    expect(own).toHaveLength(2);
    expect(commandsOf(own[1].request)).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: {}, unset: ['pinned'] }],
      },
    ]);
    await answer(1);
    expect(serverNode(X)?.data).not.toHaveProperty('pinned');
    await vi.advanceTimersByTimeAsync(5_000);
  });

  it('undoes the first setting of a data key by removing it', async () => {
    state().updateNodeData(X, { pinned: true });
    await answer(0);
    state().undo();
    expect(node(X).data).not.toHaveProperty('pinned');
    expect(commandsOf(own[1].request)).toEqual([
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
    expect(commandsOf(own[0].request)).toEqual([
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
    expect(commandsOf(own[0].request)).toEqual([
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
    state()._setStateRaw({ nodes });
    server.reset(nodes, [], 1);
  });

  it('applies a measurement here at once and reports it once, without a whole-Space save', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([
      { type: 'APPLY_MEASURED_HEIGHT', items: [measurement(400)] },
    ]);
    // Sent as this page, like any edit of it.
    expect(own[0].request.originator).toEqual({
      tabId: expect.stringMatching(/.+/),
    });

    await answer(0);
    expect(heightOf(serverNode(AUTO))).toBe(layoutHeight(400));
    expect(heightOf(node(AUTO))).toBe(layoutHeight(400));
    // A measurement is not an undo entry.
    expect(canvasHistoryManager.canUndo).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
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
    expect(commandsOf(own[0].request)).toEqual([
      { type: 'APPLY_MEASURED_HEIGHT', items: [measurement(500)] },
    ]);
  });

  it('keeps the measured height here when the server refuses the report', async () => {
    state().applyMeasuredHeights([measurement(400)]);
    await answer(0, unchanged(1, NO_OP_EDIT));
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
    state()._setStateRaw({ nodes });
    server.reset(nodes, [], 1);
  });

  it('does not ask before leaving for an unanswered measurement, and still flushes it', () => {
    state().applyMeasuredHeights([measurement(400)]);
    expect(own).toHaveLength(1);
    expect(leave().defaultPrevented).toBe(false);
    // Best effort: the report is still sent on the way out.
    expect(
      keepaliveRequests().map(([, request]) => commandsOf(request)),
    ).toEqual([[{ type: 'APPLY_MEASURED_HEIGHT', items: [measurement(400)] }]]);
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
    expect(commandsOf(own[own.length - 1].request)).toEqual([
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
    state()._setStateRaw({ nodes });
    server.reset(nodes, [], 1);
  }

  it('reports the box once and the server lays the Frame out around it, without a whole-Space save', async () => {
    seed();
    measure(200, 340);
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([
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
    expect(commandsOf(own[1].request)).toEqual([
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
    expect(commandsOf(own[0].request)).toEqual([
      { type: 'APPLY_MEASURED_SIZE', items: [item(200, 380)] },
    ]);
  });

  it('keeps its layout and stays quiet when the server ignores the report', async () => {
    seed();
    measure(200, 340);
    const local = frameHeight(node(FRAME));
    await answer(0, unchanged(1, NO_OP_EDIT));
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

describe('an edit of which one command fails', () => {
  it("is undone whole on the server; the page says so once and shows the server's Space", async () => {
    // Sent without a read version, nothing is judged up front: the engine
    // runs the commands.
    setCanvasSyncLineageForTests(SPACE, null);
    // Another page deleted X; this page has not heard of it.
    remote([{ type: 'DELETE_NODES', nodeIds: [X as `node-${string}`] }]);
    // One batch: a recolour of Y, which could stand, and one of X.
    state().executeCommands([accentCommand(Y, 'red'), accentCommand(X, 'red')]);
    // An unrelated batch behind it.
    moveHere(Y, 40, 300);
    expect(own[0].request.edits).toEqual([
      { commands: [accentCommand(Y, 'red'), accentCommand(X, 'red')] },
    ]);
    expect(accentOf(node(Y))).toBe('red');

    await answer(0);
    // The failing command carries the reason; the other one is undone.
    expect(commit(0).edits).toEqual([
      {
        applied: false,
        reason: 'not-found',
        failedAt: 1,
        results: [{ applied: false }, { applied: false, reason: 'not-found' }],
      },
    ]);
    // Not even the recolour of Y was kept.
    expect(commit(0).toVersion).toBe(commit(0).fromVersion);
    expect(accentOf(serverNode(Y) as Node)).toBe('white');
    expect(toast).toHaveBeenCalledTimes(1);
    // The held colour is put back; the reload waits for the queue.
    expect(accentOf(node(Y))).toBe('white');
    expect(api.getCanvas).not.toHaveBeenCalled();

    // The batch behind it is its own edit and is taken.
    await answer(1);
    expect(commit(1).edits).toEqual([
      { applied: true, results: [{ applied: true }] },
    ]);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(state().nodes.map((n) => n.id)).toEqual([Y]);
    expect(accentOf(node(Y))).toBe('white');
    expect(node(Y).position).toEqual({ x: 40, y: 300 });
    expect(serverNode(Y)?.position).toEqual({ x: 40, y: 300 });
    expect(state().version).toBe(server.state.version);
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });
});

describe('a move made in a container the node has left', () => {
  const F = 'node-sync-f';
  const G = 'node-sync-g';
  const frame = (id: string, x: number): Node => ({
    id,
    type: 'frame',
    position: { x, y: 1000 },
    style: { width: 400, height: 400 },
    data: { type: 'frame', label: id, sizing: 'hug' },
  });
  const sizeOf = (value: Node | undefined) => value?.style;
  const parentOf = (value: Node | undefined) => value?.parentId ?? null;
  const intoCommands = (
    id: string,
    parentId: string | null,
  ): CanvasCommand[] => [
    {
      type: 'SET_NODE_PARENT',
      nodeIds: [id as `node-${string}`],
      parentId: parentId as `node-${string}` | null,
    },
  ];
  /** A drag that ends in another container, as this page sends it. */
  function reparentHere(id: string, parentId: string | null) {
    state().executeCommands(intoCommands(id, parentId));
  }
  /** Per command of the request: why it was refused, or that it applied. */
  const refused = (index: number) =>
    commit(index).edits.flatMap((edit) =>
      edit.results.map(
        (result) => result.reason ?? (result.applied ? 'applied' : 'undone'),
      ),
    );

  /** X on the canvas, Y inside F, G empty. */
  function seed() {
    const nodes = [
      note(X, 0, 0),
      frame(F, 1000),
      { ...note(Y, 40, 80), parentId: F },
      frame(G, 2000),
    ];
    state()._setStateRaw({ nodes });
    server.reset(nodes, [], 1);
  }

  it('states the version each edit was made on, taken when the edit is made and not when it is sent', async () => {
    seed();
    moveHere(X, 500);
    expect(readsOf(own[0].request)).toEqual([{ basis: basisAt(1) }]);
    // Made at version 1, sent only after another page's write (version 2)
    // and this page's own (version 3) have been applied here.
    recolourHere(Y, 'red');
    deliver(remote([accentCommand(Y, 'green')]), 'ui');
    await answer(0);
    expect(state().version).toBe(3);
    expect(readsOf(own[1].request)).toEqual([{ basis: basisAt(1) }]);
    await answer(1);
    // An edit made now quotes what the page has applied by now.
    recolourHere(X, 'blue');
    expect(readsOf(own[2].request)).toEqual([
      { basis: basisAt(state().version) },
    ]);
  });

  it("is refused when another page put the node into a Frame first; the page shows its own whole edit until then and the server's afterwards", async () => {
    seed();
    const frameBefore = sizeOf(serverNode(F));
    moveHere(X, 500, 700);
    // A drags X into F; that commits before this page's move.
    const theirs = remote(intoCommands(X, F));
    deliver(theirs, 'ui');
    // Never A's parent with this page's coordinates.
    expect(parentOf(node(X))).toBeNull();
    expect(node(X).position).toEqual({ x: 500, y: 700 });
    const placed = { ...serverNode(X)?.position };
    const frameAfterTheirs = sizeOf(serverNode(F));

    await answer(0);
    expect(refused(0)).toEqual(['stale-parent']);
    // The server kept A's edit and the Frame did not grow for this move.
    expect(parentOf(serverNode(X))).toBe(F);
    expect(serverNode(X)?.position).toEqual(placed);
    expect(sizeOf(serverNode(F))).toEqual(frameAfterTheirs);
    expect(frameBefore).toBeDefined();
    // This page: one notice, then exactly the server's node.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(parentOf(node(X))).toBe(F);
    expect(node(X).position).toEqual(placed);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    // The refused move is not in the history any more.
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it('is refused when another page took the node out of the Frame first (the mirror case)', async () => {
    seed();
    moveHere(Y, 200, 250);
    // Where the move left Y inside F, once the Frame was fitted around it.
    const mine = { ...node(Y).position };
    const theirs = remote(intoCommands(Y, null));
    deliver(theirs, 'ui');
    expect(parentOf(node(Y))).toBe(F);
    expect(node(Y).position).toEqual(mine);
    const placed = { ...serverNode(Y)?.position };

    await answer(0);
    expect(refused(0)).toEqual(['stale-parent']);
    expect(parentOf(serverNode(Y))).toBeNull();
    expect(serverNode(Y)?.position).toEqual(placed);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(parentOf(node(Y))).toBeNull();
    expect(node(Y).position).toEqual(placed);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
  });

  it('refuses the later of two drags of one node into different Frames, as a whole', async () => {
    seed();
    // This page drags X into G and, in the same gesture, moves Y.
    state().beginGesture('SET_NODE_GEOMETRY');
    state().executeCommands([
      ...intoCommands(X, G),
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: X as `node-${string}`, position: { x: 30, y: 60 } },
          { nodeId: Y as `node-${string}`, position: { x: 90, y: 90 } },
        ],
      },
    ]);
    expect(parentOf(node(X))).toBe(G);
    // The whole gesture is one edit of two commands.
    expect(readsOf(own[0].request)).toEqual([{ basis: basisAt(1) }]);
    expect(own[0].request.edits[0]?.commands).toHaveLength(2);
    const mine = { ...node(X).position };
    deliver(remote(intoCommands(X, F)), 'ui');
    expect(parentOf(node(X))).toBe(G);
    expect(node(X).position).toEqual(mine);
    const placed = { ...serverNode(X)?.position };
    // Where A's edit left Y once F was fitted around X.
    const beside = { ...serverNode(Y)?.position };

    await answer(0);
    // Neither the parent change nor either position was taken.
    expect(refused(0)).toEqual(['stale-parent', 'stale-parent']);
    expect(parentOf(serverNode(X))).toBe(F);
    expect(serverNode(X)?.position).toEqual(placed);
    expect(serverNode(Y)?.position).toEqual(beside);
    expect(toast).toHaveBeenCalledTimes(1);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(parentOf(node(X))).toBe(F);
    expect(node(X).position).toEqual(placed);
    expect(node(Y).position).toEqual(beside);
  });

  it("stands when it is committed first, and the other page's later move is the one refused", async () => {
    seed();
    reparentHere(X, F);
    await answer(0);
    expect(parentOf(serverNode(X))).toBe(F);
    const placed = { ...serverNode(X)?.position };
    // B had not heard of it and moved X on the canvas.
    const theirs = server.execute(SPACE, {
      operationId: crypto.randomUUID(),
      originator: { tabId: 'page-b' },
      // What B had read: the Space before this page's drag.
      edits: [{ basis: basisAt(1), commands: [moveCommand(X, 700, 700)] }],
    });
    expect(theirs.edits).toEqual([
      {
        applied: false,
        reason: 'stale-parent',
        results: [{ applied: false, reason: 'stale-parent' }],
      },
    ]);
    expect(theirs.toVersion).toBe(theirs.fromVersion);
    expect(serverNode(X)?.position).toEqual(placed);
    expect(node(X).position).toEqual(placed);
    expect(toast).not.toHaveBeenCalled();
  });

  it('does not refuse its own consecutive drags: a change this page committed itself is not one it has not read', async () => {
    seed();
    reparentHere(X, F);
    // Before the first is answered: move inside F, then out again.
    moveHere(X, 60, 120);
    reparentHere(X, null);
    moveHere(X, 5, 5);
    expect(own).toHaveLength(1);
    await answer(0);
    // The edits made meanwhile were folded into one request.
    expect(own).toHaveLength(2);
    // Each was made before the first was confirmed, so each quotes the
    // version from before it (1) and names what it was made on top of. The
    // first request has been answered by now and took effect, so it is not
    // named any more.
    expect(readsOf(own[1].request)).toEqual([
      { basis: basisAt(1) },
      { basis: basisAt(1), after: [{ edit: 0 }] },
      { basis: basisAt(1), after: [{ edit: 1 }] },
    ]);
    expect(own[1].request.edits.map((edit) => edit.commands.length)).toEqual([
      1, 1, 1,
    ]);
    await answer(1);
    expect(
      [...commit(0).edits, ...commit(1).edits].every(
        (edit) =>
          edit.applied && edit.results.every((result) => result.applied),
      ),
    ).toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(parentOf(serverNode(X))).toBeNull();
    expect(serverNode(X)?.position).toEqual({ x: 5, y: 5 });
    expect(node(X).position).toEqual({ x: 5, y: 5 });
  });

  it('refuses an edit that builds on a refused one, and still takes the unrelated ones', async () => {
    seed();
    moveHere(X, 500, 700);
    // Folded into the next request while the first is on the wire.
    moveHere(X, 600, 700);
    recolourHere(Y, 'red');
    deliver(remote(intoCommands(X, F)), 'ui');
    await answer(0);
    expect(refused(0)).toEqual(['stale-parent']);
    // Told once for the refused request; the reload waits for the queue.
    expect(toast).toHaveBeenCalledTimes(1);
    expect(api.getCanvas).not.toHaveBeenCalled();
    // The second request: the move names the refused edit of the first
    // request; the recolour, of the same request, names nothing.
    expect(readsOf(own[1].request)).toEqual([
      {
        basis: basisAt(1),
        after: [{ operationId: own[0].request.operationId, edit: 0 }],
      },
      { basis: basisAt(1) },
    ]);
    await answer(1);
    expect(refused(1)).toEqual(['stale-parent', 'applied']);
    expect(commit(1).edits).toEqual([
      {
        applied: false,
        reason: 'stale-parent',
        results: [{ applied: false, reason: 'stale-parent' }],
      },
      { applied: true, results: [{ applied: true }] },
    ]);
    // One notice per refused request, and one reload for both.
    expect(toast).toHaveBeenCalledTimes(2);
    expect(accentOf(serverNode(Y) as Node)).toBe('red');
    expect(parentOf(serverNode(X))).toBe(F);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(accentOf(node(Y))).toBe('red');
    expect(parentOf(node(X))).toBe(F);
  });

  it('refuses an edit made on top of a refused one of an earlier request, although nobody else touched its node', async () => {
    seed();
    // One gesture: X into G, and X and Y placed. Y is what goes stale.
    state().beginGesture('SET_NODE_GEOMETRY');
    state().executeCommands([
      ...intoCommands(X, G),
      {
        type: 'SET_NODE_GEOMETRY',
        items: [
          { nodeId: X as `node-${string}`, position: { x: 30, y: 60 } },
          { nodeId: Y as `node-${string}`, position: { x: 90, y: 90 } },
        ],
      },
    ]);
    // Made while the first request is unanswered: X is in G on this page.
    moveHere(X, 80, 120);
    recolourHere(Y, 'red');
    deliver(remote(intoCommands(Y, null)), 'ui');
    await answer(0);
    expect(refused(0)).toEqual(['stale-parent', 'stale-parent']);
    // The second request names the refused edit it was made on top of.
    expect(own[1].request.edits[0]?.after).toEqual([
      { operationId: own[0].request.operationId, edit: 0 },
    ]);
    const before = { ...serverNode(X)?.position };
    await answer(1);
    // Not read as canvas coordinates: X never left the canvas on the server.
    expect(refused(1)).toEqual(['stale-parent', 'applied']);
    expect(parentOf(serverNode(X))).toBeNull();
    expect(serverNode(X)?.position).toEqual(before);
    expect(accentOf(serverNode(Y) as Node)).toBe('red');
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(parentOf(node(X))).toBeNull();
  });

  it('is refused when another page moved the node out of the Frame and back in meanwhile (the node is where it was, but not as this page read it)', async () => {
    seed();
    moveHere(Y, 200, 250);
    deliver(remote(intoCommands(Y, null)), 'ui');
    deliver(remote(intoCommands(Y, F)), 'ui');
    // Held whole: this page still shows its own move.
    expect(parentOf(node(Y))).toBe(F);
    const placed = { ...serverNode(Y)?.position };

    await answer(0);
    expect(refused(0)).toEqual(['stale-parent']);
    expect(parentOf(serverNode(Y))).toBe(F);
    expect(serverNode(Y)?.position).toEqual(placed);
    expect(toast).toHaveBeenCalledTimes(1);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(node(Y).position).toEqual(placed);
  });

  it('is refused with stale-target when another page deleted the node first', async () => {
    seed();
    moveHere(X, 500, 700);
    deliver(
      remote([{ type: 'DELETE_NODES', nodeIds: [X as `node-${string}`] }]),
      'ui',
    );
    await answer(0);
    expect(refused(0)).toEqual(['stale-target']);
    expect(serverNode(X)).toBeUndefined();
    expect(toast).toHaveBeenCalledTimes(1);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(state().nodes.some((candidate) => candidate.id === X)).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
  });

  it("refuses this page's next drag when another page moved the node between two of its own drags", async () => {
    seed();
    // Own (into F, version 2) …
    reparentHere(X, F);
    // … made before that is answered: a move inside F.
    moveHere(X, 60, 120);
    const first = commit(0);
    // … foreign (out again, version 3), committed between the two.
    const theirs = remote(intoCommands(X, null));
    await answer(0, first);
    deliver(theirs, 'ui');
    await answer(1);
    // The page's own change at version 2 is not held against it; the other
    // page's at version 3 is.
    expect(refused(1)).toEqual(['stale-parent']);
    expect(parentOf(serverNode(X))).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('takes a size-only resize of a node another page has re-parented meanwhile', async () => {
    seed();
    state().beginGesture('SET_NODE_GEOMETRY');
    state().setNodeGeometry([{ nodeId: X, size: { width: 320, height: 240 } }]);
    deliver(remote(intoCommands(X, F)), 'ui');
    await answer(0);
    // A size means the same in any container: both edits stand.
    expect(refused(0)).toEqual(['applied']);
    expect(parentOf(serverNode(X))).toBe(F);
    expect(serverNode(X)?.style).toMatchObject({ width: 320, height: 240 });
    expect(toast).not.toHaveBeenCalled();
  });

  const tick = (id: string, x: number, y: number, dragging = true) =>
    state().onNodesChange([
      { type: 'position', id, position: { x, y }, dragging },
    ]);

  it('keeps a node under the pointer in its own container while another page reparents it, and the drop is refused', async () => {
    seed();
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    tick(X, 150, 700);
    deliver(remote(intoCommands(X, F)), 'ui');
    // Still on the canvas, under the hand.
    expect(parentOf(node(X))).toBeNull();
    expect(node(X).position).toEqual({ x: 150, y: 700 });
    expect(api.getCanvas).not.toHaveBeenCalled();
    const placed = { ...serverNode(X)?.position };

    tick(X, 200, 700, false);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);
    expect(own).toHaveLength(1);
    // The drop was made on what the page showed during the drag: the Space
    // before the other page's change, although the page has applied the
    // rest of that update (version 2) by now.
    expect(state().version).toBe(2);
    expect(readsOf(own[0].request)).toEqual([{ basis: basisAt(1) }]);
    await flush();
    expect(api.getCanvas).not.toHaveBeenCalled();

    await answer(0);
    expect(commit(0).edits).toHaveLength(1);
    expect(commit(0).edits[0]?.applied).toBe(false);
    expect(commit(0).edits[0]?.results.every((result) => !result.applied)).toBe(
      true,
    );
    expect(parentOf(serverNode(X))).toBe(F);
    expect(serverNode(X)?.position).toEqual(placed);
    expect(toast).toHaveBeenCalledTimes(1);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(parentOf(node(X))).toBe(F);
    expect(node(X).position).toEqual(placed);
  });

  it('a cancelled drag adopts the parent and position another page gave the node meanwhile', async () => {
    seed();
    state().onNodeDragStart(new MouseEvent('mousedown'), node(X), [node(X)]);
    tick(X, 150, 700);
    deliver(remote(intoCommands(X, F)), 'ui');
    expect(parentOf(node(X))).toBeNull();

    state().cancelActiveNodeDrag();
    expect(parentOf(node(X))).toBe(F);
    expect(node(X).position).toEqual(serverNode(X)?.position);
    // The parent comes before its child, as React Flow requires.
    const ids = state().nodes.map((candidate) => candidate.id);
    expect(ids.indexOf(F)).toBeLessThan(ids.indexOf(X));
    expect(own).toHaveLength(0);
    expect(toast).not.toHaveBeenCalled();
    await flush();
    // Sibling order is the server's after one load.
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
  });

  it("takes this page's move back together with its container once another page has reparented the node", async () => {
    seed();
    moveHere(X, 500, 700);
    await answer(0);
    deliver(remote(intoCommands(X, F)), 'ui');
    expect(parentOf(node(X))).toBe(F);

    state().undo();
    // Not the old canvas coordinates read inside the Frame.
    expect(parentOf(node(X))).toBeNull();
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    await answer(1);
    expect(
      commit(1).edits.every(
        (edit) =>
          edit.applied && edit.results.every((result) => result.applied),
      ),
    ).toBe(true);
    expect(parentOf(serverNode(X))).toBeNull();
    expect(serverNode(X)?.position).toEqual({ x: 0, y: 0 });
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe('a Space that is not loaded', () => {
  it('sends nothing for edits made while the Space is loading; they are replaced by the load', async () => {
    state()._setStateRaw({ isLoading: true });
    moveHere(X, 500);
    recolourHere(Y, 'blue');
    state().patchNodeSilent(X, { pinnedForTest: 'yes' });
    state().deleteNodes([Y]);
    state().undo();
    await vi.advanceTimersByTimeAsync(3_000);
    // The page shows them, as it did before structure was sent by command …
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    // … and nothing was sent for them.
    expect(own).toHaveLength(0);
    expect(hasUnsavedCanvasEdits()).toBe(false);

    // The load that was under way brings the server's Space.
    await state().loadCanvas(SPACE);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(own).toHaveLength(0);
    // From here on edits are sent.
    moveHere(X, 700);
    expect(own).toHaveLength(1);
  });

  it('sends nothing for a Space whose first load failed, until a load succeeds', async () => {
    api.getCanvas.mockRejectedValueOnce(new Error('offline'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await state().loadCanvas('space-other');
    error.mockRestore();
    expect(state().canvasId).toBe('space-other');
    expect(state().isLoading).toBe(false);
    state()._setStateRaw({ nodes: [note(X, 0, 0)] });
    moveHere(X, 500);
    state().patchNodeSilent(X, { pinnedForTest: 'yes' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(own).toHaveLength(0);

    await state().loadCanvas('space-other');
    moveHere(X, 700);
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 700)]);
  });
});

describe('a wanted reload whose load fails', () => {
  it('keeps the page as it is, is asked for again after a backoff, and runs what follows a reload only once it has loaded', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Another page moved X; this page missed the update.
    remote([moveCommand(X, 900)]);
    api.getCanvas.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const reloaded = vi.fn();
    requestCanvasResync(SPACE, reloaded);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    // Not replaced by an empty or a "not found" page, and not reported done.
    expect(reloaded).not.toHaveBeenCalled();
    expect(state().canvasNotFound).toBe(false);
    expect(state().isLoading).toBe(false);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(state().version).toBe(1);

    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs);
    expect(api.getCanvas).toHaveBeenCalledTimes(2);
    expect(reloaded).toHaveBeenCalledTimes(1);
    expect(node(X).position).toEqual({ x: 900, y: 0 });
    expect(state().version).toBe(2);
    // Nothing asks a third time.
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.maxMs * 3);
    expect(api.getCanvas).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('is asked for again after a refused command too, where no later event would', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Another page deletes X while this page's move of it is on its way.
    moveHere(X, 500);
    const deletion = remote([{ type: 'DELETE_NODES', nodeIds: [X as never] }]);
    deliver(deletion, 'ui');
    api.getCanvas.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await answer(0);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RELOAD_RETRY.initialMs);
    expect(api.getCanvas).toHaveBeenCalledTimes(2);
    expect(state().nodes.map((n) => n.id)).toEqual([Y]);
    error.mockRestore();
  });
});

describe('a wanted reload and what the user is doing', () => {
  afterEach(() => {
    useCanvasPresenceStore.getState().setLocalEditingNodeId(null);
  });

  it('is held while this page edits a node, whose typed text is not in the store yet, and runs when the editing ends', async () => {
    // A text node keeps its draft in the control until blur: nothing is
    // pending in the content queue while the user types.
    useCanvasPresenceStore.getState().setLocalEditingNodeId(X);
    remote([moveCommand(Y, 800)]);
    const reloaded = vi.fn();
    // A refused command, a snapshot that does not match, a missing update.
    requestCanvasResync(SPACE, reloaded);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getCanvas).not.toHaveBeenCalled();
    expect(reloaded).not.toHaveBeenCalled();
    expect(node(Y).position).toEqual({ x: 0, y: 300 });
    // Editing is not something to warn about.
    expect(
      vi
        .mocked(toast)
        .mock.calls.filter(([message]) =>
          /newer changes/i.test(String(message)),
        ),
    ).toHaveLength(0);

    useCanvasPresenceStore.getState().setLocalEditingNodeId(null);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(reloaded).toHaveBeenCalledTimes(1);
    expect(node(Y).position).toEqual({ x: 800, y: 0 });
  });

  it('then waits for the text the control committed on blur to be saved', async () => {
    api.putNodeContent.mockImplementation(
      async (
        _canvasId: string,
        nodeId: string,
        request: { content?: string },
      ) => {
        saveOnServer(nodeId, request.content ?? '');
        return { nodeId, label: null, rev: 'rev-saved' };
      },
    );
    useCanvasPresenceStore.getState().setLocalEditingNodeId(X);
    requestCanvasResync(SPACE);
    await flush();
    // Blur: the draft goes to the store, then the tracker reports the end.
    state().updateNodeData(X, { content: 'Typed, then blurred' });
    useCanvasPresenceStore.getState().setLocalEditingNodeId(null);
    await flush();
    expect(api.getCanvas).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(node(X).data.content).toBe('Typed, then blurred');
  });

  it('refreshes the open Space in place: never loading, viewport and surviving selection kept, history reset', async () => {
    moveHere(Y, 0, 600);
    await answer(0);
    expect(state().canUndo).toBe(true);
    state().selectNodes([X, Y]);
    state().setViewport({ x: 120, y: -40, zoom: 1.5 });
    const loading: boolean[] = [];
    const stop = useCanvasStore.subscribe((next) => {
      loading.push(next.isLoading);
    });
    const generation = state().loadGeneration;
    // Another page deletes Y and moves X; this page missed both.
    remote([
      { type: 'DELETE_NODES', nodeIds: [Y as never] },
      moveCommand(X, 900),
    ]);
    requestCanvasResync(SPACE);
    await flush();
    stop();

    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    expect(loading).not.toContain(true);
    expect(state().nodes.map((n) => n.id)).toEqual([X]);
    expect(node(X).position).toEqual({ x: 900, y: 0 });
    expect(node(X).selected).toBe(true);
    expect(state().viewport).toEqual({ x: 120, y: -40, zoom: 1.5 });
    expect(state().version).toBe(server.state.version);
    expect(state().loadGeneration).toBe(generation + 1);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('does not use a load that an edit of this page overtook, and asks again once the edit is answered', async () => {
    let respond: (value: unknown) => void = () => undefined;
    api.getCanvas.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    requestCanvasResync(SPACE);
    await flush();
    expect(api.getCanvas).toHaveBeenCalledTimes(1);
    // The canvas is still there, so the user goes on working.
    moveHere(X, 500);
    expect(own).toHaveLength(1);
    // The load answers with the Space from before that edit.
    respond({
      canvasId: SPACE,
      title: 'Sync',
      version: 1,
      basis: server.basis(),
      state: { nodes: server.state.nodes, edges: server.state.edges },
    });
    await flush();
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(true);

    await answer(0);
    await flush();
    // Asked again, now with nothing of this page's on the way.
    expect(api.getCanvas).toHaveBeenCalledTimes(2);
    expect(node(X).position).toEqual({ x: 500, y: 0 });
    expect(state().version).toBe(2);
  });
});

describe('what is sent is decided by one rule, also around a pointer gesture', () => {
  const dataPatches = (index: number) =>
    (commandsOf(own[index].request) as CanvasCommand[]).flatMap((command) =>
      command.type === 'MERGE_NODE_DATA' ? command.patches : [],
    );
  const startDrag = () => {
    const dragged = [node(X)];
    state().onNodeDragStart(new MouseEvent('mousedown'), dragged[0], dragged);
  };
  const tick = (x: number, y: number, dragging = true) =>
    state().onNodesChange([
      { type: 'position', id: X, position: { x, y }, dragging },
    ]);

  it('does not send a read-model hint that was patched in during a drag', async () => {
    startDrag();
    tick(240, 60);
    // The content queue's own patch after a save: the hints of a node whose
    // sidecar is no longer duplicated. Shown, never sent.
    state().patchNodeSilent(X, {
      contentMissing: false,
      contentDuplicate: false,
      duplicateFiles: [],
      measuredSize: { width: 10, height: 10, measuredFor: 'k' },
    });
    tick(240, 60, false);
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);

    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 240, 60)]);
    expect(dataPatches(0)).toEqual([]);
    // Shown all the same.
    expect(node(X).data.contentDuplicate).toBe(false);
    await answer(0);
    expect(serverNode(X)?.data).not.toHaveProperty('contentDuplicate');
    expect(serverNode(X)?.data).not.toHaveProperty('duplicateFiles');
  });

  it('does not send such a hint with the batch that closes a programmatic gesture either', async () => {
    state().beginGesture('SET_NODE_GEOMETRY');
    state().patchNodeSilent(X, { contentDuplicate: false, duplicateFiles: [] });
    state().setNodeGeometry([{ nodeId: X, position: { x: 500, y: 0 } }]);
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([moveCommand(X, 500)]);
  });

  it('sends a structure patch that landed during a drag that is then cancelled', async () => {
    startDrag();
    tick(240, 60);
    state().patchNodeSilent(X, { pinnedForTest: 'yes' });
    state().cancelActiveNodeDrag();

    // The node is back where it was, and the move is not sent …
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    // … but the patch, which the drag had taken charge of, is.
    expect(own).toHaveLength(1);
    expect(commandsOf(own[0].request)).toEqual([
      {
        type: 'MERGE_NODE_DATA',
        patches: [{ nodeId: X, patch: { pinnedForTest: 'yes' } }],
      },
    ]);
    await answer(0);
    expect(serverNode(X)?.data.pinnedForTest).toBe('yes');
    expect(serverNode(X)?.position).toEqual({ x: 0, y: 0 });
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it('sends nothing for a cancelled drag during which nothing else changed', async () => {
    startDrag();
    tick(240, 60);
    state().patchNodeSilent(X, { contentDuplicate: false });
    state().cancelActiveNodeDrag();
    await flush();
    expect(own).toHaveLength(0);
  });

  it('sends a structure patch that landed during a click that moved nothing', async () => {
    startDrag();
    state().patchNodeSilent(X, { pinnedForTest: 'yes' });
    state().onNodeDragStop(new MouseEvent('mouseup'), node(X), [node(X)]);

    expect(own).toHaveLength(1);
    expect(dataPatches(0)).toEqual([
      { nodeId: X, patch: { pinnedForTest: 'yes' } },
    ]);
    // A click is not an edit: no undo entry.
    expect(canvasHistoryManager.canUndo).toBe(false);
    await answer(0);
    expect(serverNode(X)?.data.pinnedForTest).toBe('yes');
  });
});

describe('preprocessing is requested only when its input changed', () => {
  const FRAME = 'node-sync-grid';
  const PDF = 'node-sync-pdf';
  const pdf: Node = {
    id: PDF,
    type: 'pdf',
    parentId: FRAME,
    position: { x: 0, y: 0 },
    style: { width: 160, height: 160 },
    data: {
      type: 'pdf',
      label: 'Paper',
      labelSource: 'user',
      src: 'artifact-paper.pdf',
      frameColumn: 0,
      frameRow: 0,
    },
  };
  const frame: Node = {
    id: FRAME,
    type: 'frame',
    position: { x: 600, y: 0 },
    style: { width: 440, height: 440 },
    data: {
      type: 'frame',
      label: 'Papers',
      labelSource: 'user',
      layoutMode: 'grid',
      gridCount: 2,
    },
  };
  const patch = (id: string, data: Record<string, unknown>): CanvasCommand => ({
    type: 'MERGE_NODE_DATA',
    patches: [{ nodeId: id as `node-${string}`, patch: data }],
  });
  const requestedIds = () =>
    api.preprocessNode.mock.calls.map(([, nodeId]) => nodeId);
  const settle = () => vi.advanceTimersByTimeAsync(5_000);

  beforeEach(() => {
    const nodes = [...state().nodes, frame, pdf];
    server.reset(nodes, [], 1);
    state()._setStateRaw({ nodes });
  });

  it('does not request or show pending for a node whose Grid cell changed', async () => {
    state().executeCommands([patch(PDF, { frameColumn: 1, frameRow: 2 })]);

    expect(node(PDF).data.frameRow).toBe(2);
    expect(state().ingestionByNodeId[PDF]).toBeUndefined();
    await settle();
    expect(requestedIds()).toEqual([]);
  });

  it('does not request for a Frame whose stored child order changed', async () => {
    state().executeCommands([patch(FRAME, { layoutOrder: [[PDF]] })]);

    await settle();
    expect(requestedIds()).toEqual([]);
  });

  it.each([
    ['title', { label: 'Renamed paper', labelSource: 'user' }],
    ['source', { src: 'artifact-other.pdf' }],
  ])('still requests when the %s changes', async (_field, data) => {
    state().executeCommands([patch(PDF, data)]);

    expect(state().ingestionByNodeId[PDF]?.status).toBe('pending');
    await settle();
    expect(requestedIds()).toContain(PDF);
  });

  it("requests a Frame's title again when a child's title changes", async () => {
    state().executeCommands([patch(PDF, { label: 'Renamed paper' })]);

    await settle();
    expect(requestedIds()).toEqual(expect.arrayContaining([PDF, FRAME]));
  });

  it('still requests once for a node this batch created', async () => {
    state().executeCommands([
      {
        type: 'CREATE_NODES',
        nodes: [
          {
            id: 'node-sync-new',
            nodeType: 'web',
            position: { x: 0, y: 900 },
            data: { src: 'https://example.com/a' },
          },
        ],
      },
    ]);

    // The request waits for the server to take the creation.
    await answer(0);
    expect(state().ingestionByNodeId['node-sync-new']?.status).toBe('pending');
    await settle();
    expect(requestedIds()).toEqual(['node-sync-new']);
  });

  it("does not request for an agent's edit that left the input unchanged", async () => {
    const update = remote([patch(PDF, { frameColumn: 1 })]);
    deliver(update, 'agent');

    expect(node(PDF).data.frameColumn).toBe(1);
    expect(state().ingestionByNodeId[PDF]).toBeUndefined();
    await settle();
    expect(requestedIds()).toEqual([]);
  });

  it("still requests for an agent's edit that changed the title", async () => {
    deliver(remote([patch(PDF, { label: 'Agent title' })]), 'agent');

    await settle();
    expect(requestedIds()).toContain(PDF);
  });
});
