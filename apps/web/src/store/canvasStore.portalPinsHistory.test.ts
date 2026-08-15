// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteNode, getCanvas, getWorldReferences, postCanvasExecute } =
  vi.hoisted(() => ({
    deleteNode: vi.fn(),
    getCanvas: vi.fn(),
    getWorldReferences: vi.fn(),
    postCanvasExecute: vi.fn(),
  }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  deleteNode,
  getCanvas,
  getWorldReferences,
  postCanvasExecute,
}));

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { useWorkspaceStore } from './workspaceStore';

import type * as CanvasApi from '../api';
import type { PortalNodePinUpdate } from '@huabu/shared';

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
  getWorldReferences.mockReset();
  getWorldReferences.mockResolvedValue({ references: [] });
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

  useWorkspaceStore.setState({ worldCanvasId, worldEnabled: false });
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
    versionConflict: false,
    versionConflictServerVersion: null,
    worldReferences: {},
    worldReferenceError: null,
    pinnedSourceNodeIds: {},
  });
});

describe('World Portal Pin history boundary', () => {
  it('ignores an older reference refresh that completes last', async () => {
    let resolveOlder:
      | ((value: { references: Array<Record<string, unknown>> }) => void)
      | undefined;
    getWorldReferences
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce({
        references: [
          {
            kind: 'nodeRef',
            referenceNodeId: 'node-ref',
            target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
            status: 'ok',
            source: { type: 'note', label: 'Newer' },
          },
        ],
      });

    const older = useCanvasStore.getState().refreshWorldReferences();
    await useCanvasStore.getState().refreshWorldReferences();
    resolveOlder?.({
      references: [
        {
          kind: 'nodeRef',
          referenceNodeId: 'node-ref',
          target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
          status: 'ok',
          source: { type: 'note', label: 'Older' },
        },
      ],
    });
    await older;

    expect(useCanvasStore.getState().worldReferences['node-ref']).toMatchObject(
      {
        source: { label: 'Newer' },
      },
    );
  });

  it('loads resolved node references into runtime-only state', async () => {
    getCanvas.mockResolvedValueOnce({
      canvasId: worldCanvasId,
      title: 'World',
      version: 0,
      state: { nodes: [], edges: [] },
    });
    getWorldReferences.mockResolvedValueOnce({
      references: [
        {
          kind: 'nodeRef',
          referenceNodeId: 'node-ref',
          target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
          status: 'ok',
          source: { type: 'note', label: 'Source note' },
        },
      ],
    });

    await useCanvasStore.getState().loadCanvas(worldCanvasId);

    await vi.waitFor(() => {
      expect(
        useCanvasStore.getState().worldReferences['node-ref'],
      ).toMatchObject({
        status: 'ok',
        source: { label: 'Source note' },
      });
    });
  });

  it('derives pin state for the active source Space only', async () => {
    useWorkspaceStore.setState({ worldEnabled: true });
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: sourceCanvasId,
    });
    getWorldReferences.mockResolvedValueOnce({
      references: [
        {
          kind: 'canvasRef',
          referenceNodeId: 'node-portal',
          target: { canvasId: sourceCanvasId },
          status: 'ok',
          source: { title: 'Source Space' },
        },
        {
          kind: 'nodeRef',
          referenceNodeId: 'node-ref',
          target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
          status: 'ok',
          source: { type: 'note', label: 'Source note' },
        },
        {
          kind: 'frameRef',
          referenceNodeId: 'node-frame-ref',
          target: { canvasId: sourceCanvasId, nodeId: 'node-frame' },
          status: 'ok',
          source: { type: 'frame', label: 'Source frame' },
        },
        {
          kind: 'nodeRef',
          referenceNodeId: 'node-other-ref',
          target: { canvasId: 'canvas-other', nodeId: 'node-other' },
          status: 'ok',
          source: { type: 'note', label: 'Other note' },
        },
      ],
    });

    await useCanvasStore.getState().refreshWorldReferences();

    expect(getWorldReferences).toHaveBeenCalledWith(worldCanvasId);
    expect(useCanvasStore.getState().pinnedSourceNodeIds).toEqual({
      [sourceNodeId]: true,
      'node-frame': true,
    });
    expect(useCanvasStore.getState().worldReferences).toEqual({});
  });

  it('clears source pin state without requesting World when disabled', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: sourceCanvasId,
      pinnedSourceNodeIds: { [sourceNodeId]: true },
    });

    await useCanvasStore.getState().refreshWorldReferences();

    expect(getWorldReferences).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().pinnedSourceNodeIds).toEqual({});
  });

  it('refreshes source pin state after a routed World mutation', async () => {
    useWorkspaceStore.setState({ worldEnabled: true });
    useCanvasStore.getState()._setStateNoAutosave({
      canvasId: sourceCanvasId,
    });
    getWorldReferences.mockResolvedValueOnce({
      references: [
        {
          kind: 'nodeRef',
          referenceNodeId: 'node-ref',
          target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
          status: 'ok',
          source: { type: 'note', label: 'Source note' },
        },
      ],
    });

    await useCanvasStore.getState().setPortalNodePins([
      {
        sourceCanvasId,
        sourceNodeIds: [sourceNodeId],
        pinned: true,
      },
    ]);

    expect(postCanvasExecute).toHaveBeenCalledWith(
      sourceCanvasId,
      expect.objectContaining({
        commands: [
          {
            type: 'SET_PORTAL_NODE_PINS',
            updates: [
              {
                sourceCanvasId,
                sourceNodeIds: [sourceNodeId],
                pinned: true,
              },
            ],
          },
        ],
      }),
    );
    expect(getWorldReferences).toHaveBeenCalledWith(worldCanvasId);
    expect(useCanvasStore.getState().pinnedSourceNodeIds).toEqual({
      [sourceNodeId]: true,
    });
  });

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

  it('clears stale World history when a nodeRef becomes a frameRef', async () => {
    const previous = {
      id: 'node-ref',
      type: 'nodeRef' as const,
      position: { x: 0, y: 0 },
      data: {
        type: 'nodeRef' as const,
        target: { canvasId: sourceCanvasId, nodeId: sourceNodeId },
      },
    };
    const next = {
      ...previous,
      type: 'frameRef' as const,
      data: { ...previous.data, type: 'frameRef' as const },
    };
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [previous],
      version: 0,
      canUndo: true,
    });
    canvasHistoryManager.takeSnapshot([previous], []);
    postCanvasExecute.mockResolvedValueOnce({
      canvasId: worldCanvasId,
      fromVersion: 0,
      toVersion: 1,
      deltas: [{ type: 'REPLACE_NODE', prev: previous, next }],
      results: [],
      commands: [],
      pendingEffects: pendingEffects(),
    });

    await useCanvasStore.getState().setPortalNodePins([
      {
        sourceCanvasId,
        sourceNodeIds: [sourceNodeId],
        pinned: true,
      },
    ]);

    expect(useCanvasStore.getState().nodes[0]?.type).toBe('frameRef');
    expect(canvasHistoryManager.canUndo).toBe(false);
    expect(useCanvasStore.getState().canUndo).toBe(false);
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
