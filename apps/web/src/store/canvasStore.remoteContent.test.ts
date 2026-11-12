// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  putCanvas: vi.fn(),
  postCanvasExecute: vi.fn(),
  getCanvas: vi.fn(),
  deleteNode: vi.fn(),
  putNodeContent: vi.fn(),
  getNodeContent: vi.fn(),
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

import { nodeRevisionOf } from '@huabu/shared/canvas-engine';

import { toast } from '@/components/Common/Toast';

import { canvasHistoryManager } from './canvasHistoryManager';
import { useCanvasPresenceStore } from './canvasPresence/canvasPresenceStore';
import useCanvasStore, {
  adoptRemoteNodeContent,
  hasUnsavedCanvasEdits,
  resetCanvasSyncForTests,
} from './canvasStore';
import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';
import { createFakeSpaceServer } from './canvasStore/sync/testing/fakeExecuteServer';

import type * as apiModule from '../api';
import type * as canvasApiModule from '../api/canvas';
import type { Node } from '@xyflow/react';

/**
 * The real store receives content another page saved. What must not follow
 * on the receiving page: a save, an undo entry, a preprocessing run, or a
 * change to selection.
 */

const SPACE = 'space-remote-content';
const X = 'node-content-x';
const Y = 'node-content-y';

const note = (id: string, x: number): Node => ({
  id,
  type: 'note',
  position: { x, y: 0 },
  style: { width: 300, height: 200 },
  data: {
    type: 'note',
    label: `Label ${id}`,
    content: `Body ${id}`,
    heightMode: 'fixed',
    style: { accent: 'white' },
  },
});

const state = () => useCanvasStore.getState();
const node = (id: string): Node => {
  const found = state().nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing node ${id}`);
  return found;
};
const savedOnServer = (content: string, label: string) => ({
  nodeId: X,
  type: 'note',
  label,
  content,
  rev: nodeRevisionOf({ content }),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCanvasSyncForTests();
  const nodes = [{ ...note(X, 0), selected: true }, note(Y, 400)];
  canvasHistoryManager.activate(SPACE, true);
  state()._setStateNoAutosave({
    canvasId: SPACE,
    canvasTitle: 'Content',
    nodes,
    edges: [],
    version: 1,
    isLoading: false,
    canUndo: false,
    canRedo: false,
  });
  api.postCanvasExecute.mockImplementation(() => new Promise(() => {}));
  api.putNodeContent.mockImplementation(
    async (_canvasId: string, nodeId: string, body: { content?: string }) => ({
      nodeId,
      label: null,
      rev: nodeRevisionOf({ content: body.content ?? '' }),
    }),
  );
  api.preprocessNode.mockResolvedValue({ success: true });
  api.postCanvasEvents.mockResolvedValue({ success: true });
  // The content queue outlives a test; a fetch it still owes finds nothing.
  api.getNodeContent.mockReset();
  api.getNodeContent.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('content another page saved, in the store', () => {
  it('is shown without a save, an undo entry, a preprocessing run or a selection change', async () => {
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    const other = node(Y);

    await expect(adoptRemoteNodeContent(SPACE, [X])).resolves.toEqual([
      'applied',
    ]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
      style: { accent: 'white' },
    });
    expect(node(X).selected).toBe(true);
    expect(node(X).position).toEqual({ x: 0, y: 0 });
    expect(node(Y)).toBe(other);
    expect(state().canUndo).toBe(false);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(state().pendingContentNodeIds()).toEqual([]);
    expect(hasUnsavedCanvasEdits()).toBe(false);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(api.postCanvasExecute).not.toHaveBeenCalled();
    expect(api.preprocessNode).not.toHaveBeenCalled();
  });

  it("sends this page's next edit of the node from the adopted revision, naming the page", async () => {
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);

    state().updateNodeData(X, { content: 'Body from A, then B' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Body from A, then B',
      label: 'From A',
      expectRev: nodeRevisionOf({ content: 'Body from A' }),
      pageId: CANVAS_PAGE_ID,
    });
  });

  it('is not put back, or saved over, by undoing an earlier local edit', async () => {
    // This page recolours X; that is its undo entry.
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);
    expect(state().canUndo).toBe(true);
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);

    state().undo();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
      style: { accent: 'white' },
    });
    expect(api.putNodeContent).not.toHaveBeenCalled();

    state().redo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      style: { accent: 'red' },
    });
    expect(api.putNodeContent).not.toHaveBeenCalled();
  });

  it('comes back with the node when this page deletes it and undoes the deletion', async () => {
    // This case needs the server to answer: the restore follows the delete.
    const server = createFakeSpaceServer();
    server.reset(state().nodes, [], 1);
    api.postCanvasExecute.mockImplementation(async (canvasId, request) =>
      server.execute(canvasId, request),
    );
    // An entry taken while X still had its first body.
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );
    await adoptRemoteNodeContent(SPACE, [X]);
    api.deleteNode.mockResolvedValue({ success: true });

    state().deleteNodes([X]);
    expect(state().nodes.map((n) => n.id)).toEqual([Y]);
    state().undo();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(node(X).data).toMatchObject({
      content: 'Body from A',
      label: 'From A',
    });
    // The restoring batch carries the adopted body, not the entry's first.
    const restored = server.requests
      .flatMap(
        (request) =>
          request.commands as Array<{ type: string; nodes?: Node[] }>,
      )
      .filter((command) => command.type === 'RESTORE_NODES')
      .flatMap((command) => command.nodes ?? [])
      .filter((restoredNode) => restoredNode.id === X);
    expect(restored.map((restoredNode) => restoredNode.data.content)).toEqual([
      'Body from A',
    ]);
    expect(
      server.state.nodes.find((serverNode) => serverNode.id === X)?.data
        .content,
    ).toBe('Body from A');
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(hasUnsavedCanvasEdits()).toBe(false);
  });

  it('leaves a node this page is still saving exactly as typed', async () => {
    state().updateNodeData(X, { content: 'Typed on this page' });
    api.getNodeContent.mockResolvedValue(
      savedOnServer('Body from A', 'From A'),
    );

    await expect(adoptRemoteNodeContent(SPACE, [X])).resolves.toEqual([
      'kept-local',
    ]);

    expect(api.getNodeContent).not.toHaveBeenCalled();
    expect(node(X).data).toMatchObject({
      content: 'Typed on this page',
      label: `Label ${X}`,
    });
  });
});

describe('a body typed on this page while an update for another node arrives', () => {
  it('is saved from the revision the server holds, not from its own', async () => {
    // The queue outlives a test: start from what the server holds.
    api.getNodeContent.mockResolvedValue({
      ...savedOnServer(`Body ${Y}`, `Label ${Y}`),
      nodeId: Y,
    });
    await adoptRemoteNodeContent(SPACE, [Y]);
    state().updateNodeData(Y, { content: 'Typed while X moved' });
    // Another page moved X before this page's save was sent.
    const moved = { ...node(X), position: { x: 400, y: 300 } };
    state().applyDeltasFromAgent(
      [{ type: 'REPLACE_NODE', prev: node(X), next: moved }] as never,
      2,
      {
        mutatedNodes: [],
        deletedNodeIds: [],
        contentEditedNodeIds: [],
        deferredFitFrameIds: [],
      } as never,
      undefined,
      undefined,
      { source: 'ui' },
    );
    expect(node(X).position).toEqual({ x: 400, y: 300 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(api.putNodeContent).toHaveBeenCalledTimes(1);
    expect(api.putNodeContent.mock.calls[0][2]).toMatchObject({
      content: 'Typed while X moved',
      expectRev: nodeRevisionOf({ content: `Body ${Y}` }),
    });
  });
});

describe('renaming a node another page is editing', () => {
  const editedBy = (editingNodeIds: string[]) =>
    useCanvasPresenceStore.getState().applyEvent({
      op: 'update',
      page: {
        pageId: 'page-a',
        colorIndex: 0,
        label: 'Chrome · Mac',
        pointer: null,
        selectedNodeIds: [],
        draggingNodeIds: [],
        editingNodeIds,
      },
    });

  beforeEach(() => {
    useCanvasPresenceStore.setState({
      pages: {},
      pointers: {},
      localEditingNodeId: null,
    });
  });

  it('is refused with a hint, from whichever surface asks, and allowed again once that page finishes', async () => {
    editedBy([X]);

    await expect(state().tryRename('node', X, 'Renamed here')).resolves.toBe(
      false,
    );
    expect(node(X).data.label).toBe(`Label ${X}`);
    expect(api.putNodeContent).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('Chrome · Mac'),
      { tone: 'info' },
    );

    // A node nobody else is editing is renamed as before.
    await expect(state().tryRename('node', Y, 'Renamed Y')).resolves.toBe(true);
    expect(node(Y).data.label).toBe('Renamed Y');

    editedBy([]);
    await expect(state().tryRename('node', X, 'Renamed here')).resolves.toBe(
      true,
    );
    expect(node(X).data.label).toBe('Renamed here');
  });

  it('leaves moving and recolouring the node alone', async () => {
    editedBy([X]);

    state().beginGesture('SET_NODE_GEOMETRY');
    state().setNodeGeometry([{ nodeId: X, position: { x: 250, y: 40 } }]);
    state().executeCommands([
      {
        type: 'MERGE_NODE_DATA',
        patches: [
          {
            nodeId: X as `node-${string}`,
            patch: { style: { accent: 'red' } },
          },
        ],
      },
    ]);

    expect(node(X).position).toEqual({ x: 250, y: 40 });
    expect(node(X).data.style).toEqual({ accent: 'red' });
    expect(toast).not.toHaveBeenCalled();
  });
});
