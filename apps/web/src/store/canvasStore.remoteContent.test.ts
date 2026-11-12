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

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore, {
  adoptRemoteNodeContent,
  hasUnsavedCanvasEdits,
  resetCanvasSyncForTests,
} from './canvasStore';
import { CANVAS_PAGE_ID } from './canvasStore/sync/pageId';

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
    isSaving: false,
    pendingSave: false,
    versionConflict: false,
    versionConflictServerVersion: null,
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
    expect(state().pendingSave).toBe(false);
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
