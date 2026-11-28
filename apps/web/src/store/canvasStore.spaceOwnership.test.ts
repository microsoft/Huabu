// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, { resetCanvasSyncForTests } from './canvasStore';
import {
  createFakeSpaceServer,
  seedStoredNodes,
} from './canvasStore/sync/testing/fakeExecuteServer';
import { useGesturePreviewStore } from './gesturePreviewStore';
import { useWorkspaceStore } from './workspaceStore';
import * as api from '../api';
import * as notifications from '../components/Common/Toast';
import { REQUEST_DELETE_SPACE } from '../utils/spaceHierarchy';

import type { Delta } from '@huabu/shared/canvas-engine';
import type { Node } from '@xyflow/react';

const entry: Node = {
  id: 'node-entry',
  type: 'spacePreview',
  position: { x: 0, y: 0 },
  data: { targetCanvasId: 'child' },
};
// Structure edits are sent as execute requests; this stands in for the server.
const server = createFakeSpaceServer();
/** Node ids this page asked the server to delete (through `execute`). */
function sentDeletions(): string[] {
  return vi.mocked(api.postCanvasExecute).mock.calls.flatMap(([, request]) =>
    (
      request.edits.flatMap((edit) => edit.commands) as Array<{
        type: string;
        nodeIds?: string[];
      }>
    ).flatMap((command) =>
      command.type === 'DELETE_NODES' ? (command.nodeIds ?? []) : [],
    ),
  );
}
/** Every command this page sent to the server. */
function sentCommands(): Array<{ type: string } & Record<string, unknown>> {
  return vi
    .mocked(api.postCanvasExecute)
    .mock.calls.flatMap(
      ([, request]) =>
        request.edits.flatMap((edit) => edit.commands) as Array<
          { type: string } & Record<string, unknown>
        >,
    );
}
const originalRefresh = useWorkspaceStore.getState().refreshSpaceTitles;
const refresh = vi.fn(async () => undefined);
const edge = {
  id: 'edge-other',
  source: 'node-a',
  target: 'node-b',
  selected: true,
};
const endpoints: Node[] = ['node-a', 'node-b'].map((id) => ({
  id,
  type: 'note',
  position: { x: 0, y: 0 },
  data: { content: id },
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  server.reset([], [], 0);
  resetCanvasSyncForTests();
  vi.spyOn(api, 'postCanvasExecute').mockImplementation(
    async (canvasId, request) => server.execute(canvasId, request),
  );
  vi.spyOn(notifications, 'toast').mockImplementation(() => '');
  canvasHistoryManager.activate('parent', true);
  useCanvasStore.getState()._setStateRaw({
    canvasId: 'parent',
    nodes: [],
    edges: [],
    version: 0,
    isLoading: false,
  });
  useWorkspaceStore.setState({
    workspaceId: 'workspace',
    isReady: true,
    isSyncing: false,
    spaceTitles: { child: 'Child' },
    spaceSummaries: {},
    spaceTitlesStatus: 'loading',
    refreshSpaceTitles: refresh,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  useWorkspaceStore.setState({ refreshSpaceTitles: originalRefresh });
});

function knowChild() {
  useWorkspaceStore.setState({
    spaceTitlesStatus: 'ready',
    spaceSummaries: {
      child: { parentSpaceId: 'parent', parentEntryNodeId: entry.id },
    },
  });
}

it('does not undo a newly received child entry before or after ownership metadata arrives', async () => {
  useCanvasStore
    .getState()
    .applyServerDeltas([{ type: 'INSERT_NODE', node: entry } as Delta], 1, {
      mutatedNodeIds: [],
      deletedNodeIds: [],
      contentEditedNodeIds: [],
      deferredFitFrameIds: [],
    });
  refresh.mockClear();
  await useCanvasStore.getState().undo();
  expect(refresh).toHaveBeenCalledOnce();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(canvasHistoryManager.canUndo).toBe(true);
  knowChild();
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes[0].id).toBe(entry.id);
  expect(sentDeletions()).toEqual([]);
  expect(notifications.toast).toHaveBeenCalled();
});

it('allows geometry undo and redo for canonical entries', async () => {
  knowChild();
  canvasHistoryManager.takeSnapshot([entry], []);
  useCanvasStore.getState()._setStateRaw({
    nodes: [{ ...entry, position: { x: 50, y: 60 } }],
  });
  // Undo and redo of a move are sent as commands; the server has the entry.
  server.reset([{ ...entry, position: { x: 50, y: 60 } }], [], 0);
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes[0].position).toEqual(entry.position);
  await useCanvasStore.getState().redo();
  expect(useCanvasStore.getState().nodes[0].position).toEqual({ x: 50, y: 60 });
  expect(notifications.toast).not.toHaveBeenCalled();
});

it.each(['loading', 'error', 'ready'] as const)(
  'blocks a Frame deletion before deleting any ordinary descendants when ownership is missing (%s)',
  (spaceTitlesStatus) => {
    useWorkspaceStore.setState({ spaceTitlesStatus });
    const nodes: Node[] = [
      { id: 'node-frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
      { ...entry, parentId: 'node-frame' },
      {
        id: 'node-note',
        type: 'note',
        parentId: 'node-frame',
        position: { x: 0, y: 0 },
        data: { content: 'Keep' },
      },
    ];
    nodes.push(...endpoints);
    useCanvasStore.getState()._setStateRaw({ nodes, edges: [edge] });
    useCanvasStore.getState().deleteNodes(['node-frame'], [edge.id]);
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual([edge]);
    expect(sentDeletions()).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
  },
);

it('defers the complete mixed node/edge deletion while child confirmation is pending', () => {
  knowChild();
  const nodes = [entry, ...endpoints];
  useCanvasStore.getState()._setStateRaw({ nodes, edges: [edge] });
  const confirm = vi.fn();
  window.addEventListener(REQUEST_DELETE_SPACE, confirm);
  try {
    useCanvasStore.getState().deleteNodes([entry.id], [edge.id]);
    expect(confirm).toHaveBeenCalledOnce();
    expect(useCanvasStore.getState().nodes).toEqual(nodes);
    expect(useCanvasStore.getState().edges).toEqual([edge]);
    expect(sentDeletions()).toEqual([]);
    expect(canvasHistoryManager.canUndo).toBe(false);
  } finally {
    window.removeEventListener(REQUEST_DELETE_SPACE, confirm);
  }
});

it('keeps selected edges when deleting a Frame with a known child entry is refused', () => {
  knowChild();
  const nodes = [
    { id: 'node-frame', type: 'frame', position: { x: 0, y: 0 }, data: {} },
    { ...entry, parentId: 'node-frame' },
    ...endpoints,
  ];
  useCanvasStore.getState()._setStateRaw({ nodes, edges: [edge] });
  useCanvasStore.getState().deleteNodes(['node-frame'], [edge.id]);
  expect(useCanvasStore.getState().nodes).toEqual(nodes);
  expect(useCanvasStore.getState().edges).toEqual([edge]);
  expect(sentDeletions()).toEqual([]);
  expect(notifications.toast).toHaveBeenCalled();
  expect(canvasHistoryManager.canUndo).toBe(false);
});

it('deletes ordinary nodes and selected edges in one undoable execution', async () => {
  const note: Node = {
    id: 'node-note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: { content: 'Ordinary' },
  };
  // As loaded from the server: every node has its paint key.
  const nodes = seedStoredNodes([note, ...endpoints]);
  useCanvasStore.getState()._setStateRaw({ nodes, edges: [edge] });
  server.reset(nodes, [edge], 0);
  useCanvasStore.getState().deleteNodes([note.id], [edge.id]);
  expect(useCanvasStore.getState().nodes).toEqual(nodes.slice(1));
  expect(useCanvasStore.getState().edges).toEqual([]);
  await vi.waitFor(() => expect(sentDeletions()).toEqual([note.id]));
  await useCanvasStore.getState().undo();
  expect(useCanvasStore.getState().nodes).toEqual(nodes);
  expect(useCanvasStore.getState().edges).toEqual([
    { id: edge.id, source: edge.source, target: edge.target },
  ]);
  expect(canvasHistoryManager.canUndo).toBe(false);
});

it('also protects direct command deletion instead of relying on UI Delete', () => {
  knowChild();
  useCanvasStore.getState()._setStateRaw({ nodes: [entry] });
  useCanvasStore
    .getState()
    .executeCommands([{ type: 'DELETE_NODES', nodeIds: ['node-entry'] }]);
  expect(useCanvasStore.getState().nodes).toEqual([entry]);
  expect(sentDeletions()).toEqual([]);
});

it('refuses to cut a selection that owns a child Space, leaving nodes and clipboard alone', async () => {
  knowChild();
  const note = {
    id: 'cut-note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    selected: true,
  };
  useCanvasStore
    .getState()
    ._setStateRaw({ nodes: [{ ...entry, selected: true }, note] });
  const copy = vi.spyOn(useCanvasStore.getState(), 'copySelectedNodes');
  vi.mocked(notifications.toast).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  expect(copy).not.toHaveBeenCalled();
  expect(notifications.toast).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('cannot be cut'),
    { tone: 'warning' },
  );
});

it('cuts an ordinary selection by copying it and then removing it, but not during a stroke selection', async () => {
  const note = {
    id: 'cut-note',
    type: 'note',
    position: { x: 0, y: 0 },
    data: {},
    selected: true,
  };
  useCanvasStore.getState()._setStateRaw({ nodes: [note] });
  const copy = vi
    .spyOn(useCanvasStore.getState(), 'copySelectedNodes')
    .mockResolvedValue(true);

  useGesturePreviewStore.setState({
    sketchStrokeSelection: { sketch: ['stroke'] },
  });
  await useCanvasStore.getState().cutSelectedNodes();
  expect(copy).not.toHaveBeenCalled();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  useGesturePreviewStore.setState({ sketchStrokeSelection: {} });

  // A clipboard that refuses the write keeps the nodes and says so.
  copy.mockResolvedValueOnce(false);
  vi.mocked(notifications.toast).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(notifications.toast).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    { tone: 'danger' },
  );
  copy.mockClear();

  // An Agent node with a conversation cannot get its history back on paste.
  const agent = {
    ...note,
    id: 'cut-agent',
    type: 'question',
    data: { threadId: 'thread-1', status: 'done' },
  };
  useCanvasStore.getState()._setStateRaw({ nodes: [note, agent] });
  vi.mocked(notifications.toast).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(copy).not.toHaveBeenCalled();
  expect(useCanvasStore.getState().nodes).toHaveLength(2);
  expect(notifications.toast).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('conversation cannot be cut'),
    { tone: 'warning' },
  );
  useCanvasStore.getState()._setStateRaw({ nodes: [note] });

  // A node edited while the write was pending was not copied in that form.
  copy.mockImplementationOnce(async () => {
    useCanvasStore.getState()._setStateRaw({
      nodes: [{ ...note, data: { content: 'edited meanwhile' } }],
    });
    return true;
  });
  vi.mocked(notifications.toast).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(notifications.toast).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('changed while it was being copied'),
    { tone: 'warning' },
  );
  copy.mockClear();

  // So was an edge that reached the node while the write was pending.
  copy.mockImplementationOnce(async () => {
    useCanvasStore.getState()._setStateRaw({
      edges: [{ id: 'late', source: note.id, target: note.id }],
    });
    return true;
  });
  vi.mocked(notifications.toast).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(useCanvasStore.getState().nodes).toHaveLength(1);
  expect(notifications.toast).toHaveBeenCalledOnce();
  copy.mockClear();

  // A selected edge between nodes that stay never reaches the clipboard, so
  // cut must leave it alone.
  const stay = (id: string) => ({ ...note, id, selected: false });
  const kept = { id: 'kept', source: 'a', target: 'b', selected: true };
  const taken = { id: 'taken', source: 'a', target: note.id };
  const cutNodes = seedStoredNodes([note, stay('a'), stay('b')]);
  useCanvasStore.getState()._setStateRaw({
    nodes: cutNodes,
    edges: [kept, taken],
  });
  // The server holds the same Space; the cut reaches it as one batch.
  server.reset(cutNodes, [kept, taken], 0);
  vi.mocked(api.postCanvasExecute).mockClear();
  await useCanvasStore.getState().cutSelectedNodes();
  expect(copy).toHaveBeenCalledOnce();
  expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual(['a', 'b']);
  expect(useCanvasStore.getState().edges.map((e) => e.id)).toEqual(['kept']);
  // The removal is a command batch through the send queue: the cut node
  // only, and no command names the edge that stays.
  await vi.waitFor(() => expect(sentDeletions()).toEqual([note.id]));
  expect(JSON.stringify(sentCommands())).not.toContain('"kept"');
  expect(server.state.nodes.map((n) => n.id)).toEqual(['a', 'b']);
  expect(server.state.edges.map((e) => e.id)).toEqual(['kept']);

  // One undo brings back the cut node together with the edge it took.
  await useCanvasStore.getState().undo();
  expect(
    useCanvasStore
      .getState()
      .nodes.map((n) => n.id)
      .sort(),
  ).toEqual(['a', 'b', note.id]);
  expect(
    useCanvasStore
      .getState()
      .edges.map((e) => e.id)
      .sort(),
  ).toEqual(['kept', 'taken']);
  expect(canvasHistoryManager.canUndo).toBe(false);
  // The server gets them back in one restoring batch.
  await vi.waitFor(() =>
    expect(server.state.nodes.map((n) => n.id).sort()).toEqual([
      'a',
      'b',
      note.id,
    ]),
  );
  expect(server.state.edges.map((e) => e.id).sort()).toEqual(['kept', 'taken']);
  const restoringRequests = vi
    .mocked(api.postCanvasExecute)
    .mock.calls.map(
      ([, request]) =>
        request.edits.flatMap((edit) => edit.commands) as Array<{
          type: string;
          nodes?: Array<{ id: string }>;
          edges?: Array<{ id: string }>;
        }>,
    )
    .filter((commands) =>
      commands.some((command) => command.type === 'RESTORE_NODES'),
    );
  expect(restoringRequests).toHaveLength(1);
  const restoring = restoringRequests[0].filter(
    (command) => command.type === 'RESTORE_NODES',
  );
  expect(
    restoring.flatMap((command) => (command.nodes ?? []).map((n) => n.id)),
  ).toEqual([note.id]);
  expect(
    restoring.flatMap((command) => (command.edges ?? []).map((e) => e.id)),
  ).toContain('taken');
});

it('does not consume a redo snapshot that would remove a now-canonical entry', async () => {
  useWorkspaceStore.setState({
    spaceTitlesStatus: 'ready',
    spaceSummaries: { child: { parentSpaceId: null, parentEntryNodeId: null } },
  });
  // A snapshot holds nodes as the page had them: keyed.
  const [keyed] = seedStoredNodes([entry]);
  canvasHistoryManager.takeSnapshot([keyed], []);
  await useCanvasStore.getState().undo();
  knowChild();
  await useCanvasStore.getState().redo();
  expect(useCanvasStore.getState().nodes).toEqual([keyed]);
  expect(canvasHistoryManager.canRedo).toBe(true);
  expect(sentDeletions()).toEqual([]);
});

it('lets a confirmed missing-target shortcut be deleted after metadata settles', async () => {
  useWorkspaceStore.setState({ spaceTitlesStatus: 'ready', spaceTitles: {} });
  useCanvasStore.getState()._setStateRaw({ nodes: [entry] });
  server.reset([entry], [], 0);
  useCanvasStore
    .getState()
    .dispatchUiIntent({ type: 'DELETE_NODES', nodeIds: [entry.id] });
  expect(useCanvasStore.getState().nodes).toEqual([]);
  // The deletion is one command batch; the server removes the record in it.
  await vi.waitFor(() => expect(sentDeletions()).toEqual([entry.id]));
});
