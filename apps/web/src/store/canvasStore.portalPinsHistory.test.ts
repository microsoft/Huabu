import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteNode, getCanvas, postCanvasExecute } = vi.hoisted(() => ({
  deleteNode: vi.fn(),
  getCanvas: vi.fn(),
  postCanvasExecute: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  deleteNode,
  getCanvas,
  postCanvasExecute,
}));

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { useWorkspaceStore } from './workspaceStore';

import type * as CanvasApi from '../api';
import type { PortalNodePinUpdate } from '@sediment/shared';

const sourceCanvasId = 'canvas-source' as const;
const sourceNodeId = 'node-source' as const;
const worldCanvasId = 'canvas-world';

function pendingEffects() {
  return {
    mutatedNodes: [],
    deletedNodeIds: [],
    contentEditedNodeIds: [],
    deferredFitFrameIds: [],
  };
}

beforeEach(() => {
  postCanvasExecute.mockReset();
  getCanvas.mockReset();
  deleteNode.mockReset();
  deleteNode.mockResolvedValue(undefined);
  postCanvasExecute.mockImplementation(
    async (
      _callerCanvasId: string,
      request: {
        commands: Array<{
          type: 'SET_PORTAL_NODE_PINS';
          updates: PortalNodePinUpdate[];
        }>;
      },
    ) => {
      const node = {
        id: 'node-ref',
        type: 'nodeRef',
        position: { x: 0, y: 0 },
        data: {
          target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
        },
      };
      return {
        canvasId: worldCanvasId,
        fromVersion: 0,
        toVersion: 1,
        deltas: [{ type: 'INSERT_NODE' as const, node }],
        results: [{ command: request.commands[0], applied: true }],
        commands: request.commands,
        pendingEffects: pendingEffects(),
      };
    },
  );

  useWorkspaceStore.setState({ worldCanvasId });
  canvasHistoryManager.activate(worldCanvasId, true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: worldCanvasId,
    nodes: [],
    edges: [],
    version: 0,
    canUndo: false,
    canRedo: false,
    isSaving: false,
    pendingSave: false,
    isLoading: true,
  });
});

describe('World Portal Pin history boundary', () => {
  it('clears stale World history after reference topology changes', async () => {
    canvasHistoryManager.takeSnapshot([], []);
    useCanvasStore.getState()._setStateNoAutosave({ canUndo: true });

    await useCanvasStore.getState().setPortalNodePins([
      {
        sourceCanvasId,
        sourceNodeIds: [sourceNodeId],
        pinned: true,
      },
    ]);

    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(canvasHistoryManager.canRedo).toBe(false);
    expect(useCanvasStore.getState().canUndo).toBe(false);
    expect(useCanvasStore.getState().canRedo).toBe(false);
  });

  it('waits for an active structure save before pinning', async () => {
    useCanvasStore.getState()._setStateNoAutosave({ isSaving: true });

    const pin = useCanvasStore.getState().setPortalNodePins([
      {
        sourceCanvasId,
        sourceNodeIds: [sourceNodeId],
        pinned: true,
      },
    ]);
    await Promise.resolve();
    expect(postCanvasExecute).not.toHaveBeenCalled();

    useCanvasStore.getState()._setStateNoAutosave({ isSaving: false });
    await pin;

    expect(postCanvasExecute).toHaveBeenCalledTimes(1);
  });

  it('does not clear the active Space history for a routed World mutation', async () => {
    canvasHistoryManager.takeSnapshot([], []);
    canvasHistoryManager.activate('canvas-space', true);
    canvasHistoryManager.takeSnapshot([], []);
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-space',
      nodes: [],
      edges: [],
      version: 0,
      canUndo: true,
      canRedo: false,
    });

    await useCanvasStore.getState().setPortalNodePins([
      {
        sourceCanvasId,
        sourceNodeIds: [sourceNodeId],
        pinned: true,
      },
    ]);

    expect(canvasHistoryManager.canUndo).toBe(true);
    expect(useCanvasStore.getState().canUndo).toBe(true);
    canvasHistoryManager.activate(worldCanvasId);
    expect(canvasHistoryManager.canUndo).toBe(false);
  });

  it('invalidates inactive World history when a later load reveals reference changes', async () => {
    getCanvas.mockResolvedValueOnce({
      canvasId: worldCanvasId,
      title: 'World',
      version: 0,
      state: { nodes: [], edges: [] },
    });
    await useCanvasStore
      .getState()
      .loadCanvas(worldCanvasId, { resetHistory: true });
    canvasHistoryManager.takeSnapshot([], []);

    canvasHistoryManager.activate('canvas-space', true);
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: 'canvas-space',
      nodes: [],
      edges: [],
      version: 0,
      canUndo: false,
      canRedo: false,
    });
    getCanvas.mockResolvedValueOnce({
      canvasId: worldCanvasId,
      title: 'World',
      version: 1,
      state: {
        nodes: [
          {
            id: 'node-frame',
            type: 'frame',
            position: { x: 0, y: 0 },
            data: { type: 'frame' },
          },
          {
            id: 'node-portal',
            type: 'canvasRef',
            parentId: 'node-frame',
            position: { x: 0, y: 0 },
            data: { type: 'canvasRef', targetCanvasId: sourceCanvasId },
          },
          {
            id: 'node-ref',
            type: 'nodeRef',
            parentId: 'node-portal',
            position: { x: 0, y: 0 },
            data: {
              type: 'nodeRef',
              target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
            },
          },
        ],
        edges: [],
      },
    });

    await useCanvasStore.getState().loadCanvas(worldCanvasId);

    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(useCanvasStore.getState().canUndo).toBe(false);
  });

  it('clears World history when deleting a broken Portal subtree', () => {
    useWorkspaceStore.setState({
      spaceTitles: {},
      spaceTitlesLoaded: true,
    });
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: worldCanvasId,
      nodes: [
        {
          id: 'node-frame',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: { type: 'frame' },
        },
        {
          id: 'node-portal',
          type: 'canvasRef',
          parentId: 'node-frame',
          position: { x: 0, y: 0 },
          data: { type: 'canvasRef', targetCanvasId: sourceCanvasId },
        },
        {
          id: 'node-ref',
          type: 'nodeRef',
          parentId: 'node-portal',
          position: { x: 0, y: 0 },
          data: {
            type: 'nodeRef',
            target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
          },
        },
      ],
      edges: [],
      version: 0,
      canUndo: false,
      canRedo: false,
    });
    canvasHistoryManager.activate(worldCanvasId, true);
    canvasHistoryManager.takeSnapshot(useCanvasStore.getState().nodes, []);

    useCanvasStore.getState().deleteNodes(['node-frame']);

    expect(useCanvasStore.getState().nodes.map((node) => node.id)).toEqual([]);
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(useCanvasStore.getState().canUndo).toBe(false);
  });
});
