// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getCanvas: vi.fn(),
  putCanvas: vi.fn(),
  deleteNode: vi.fn(),
}));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof canvasApi>()),
  ...api,
}));

import { canvasHistoryManager } from './canvasHistoryManager';
import useCanvasStore from './canvasStore';
import { usePreviewWorkspaceStore } from './previewWorkspace/store';

import type * as canvasApi from '../api';
import type { Edge, Node } from '@xyflow/react';

function storedGraph(): { nodes: Node[]; edges: Edge[] } {
  return {
    nodes: [
      {
        id: 'portal',
        type: 'canvasRef',
        position: { x: 100, y: 200 },
        data: {},
      },
      {
        id: 'pin',
        type: 'frameRef',
        parentId: 'portal',
        position: { x: 20, y: 30 },
        data: {},
      },
      {
        id: 'ref',
        type: 'nodeRef',
        parentId: 'pin',
        position: { x: 0, y: 0 },
        data: {},
      },
      {
        id: 'frame',
        type: 'frame',
        parentId: 'pin',
        extent: 'parent',
        position: { x: 5, y: 6 },
        style: { width: 300, height: 200 },
        data: { type: 'frame', label: 'Frame', sizing: 'manual' },
      },
      {
        id: 'note',
        type: 'note',
        parentId: 'frame',
        position: { x: 7, y: 8 },
        style: { width: 150, height: 100 },
        data: {
          type: 'note',
          label: 'Note',
          heightMode: 'fixed',
          content: 'Keep this note',
        },
      },
      {
        id: 'preview',
        type: 'spacePreview',
        position: { x: 500, y: 600 },
        style: { width: 480, height: 320 },
        data: {
          type: 'spacePreview',
          targetCanvasId: 'canvas-target',
          label: 'Preview',
        },
      },
    ],
    edges: [
      { id: 'incident', source: 'ref', target: 'note' },
      { id: 'ordinary', source: 'note', target: 'preview' },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  canvasHistoryManager.activate('canvas-loaded', true);
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: '',
    nodes: [],
    edges: [],
    version: 0,
    isLoading: false,
    isSaving: false,
    pendingSave: false,
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('legacy topology load boundary', () => {
  it('ignores retired nodes without mutating stored data, issuing deletes, or saving on load', async () => {
    const graph = storedGraph();
    const before = JSON.stringify(graph);
    api.getCanvas.mockResolvedValue({
      canvasId: 'canvas-loaded',
      title: 'Loaded',
      version: 9,
      state: graph,
    });
    localStorage.setItem('legacy-topology-fixture', before);

    await useCanvasStore.getState().loadCanvas('canvas-loaded');
    await vi.advanceTimersByTimeAsync(2000);

    const loaded = useCanvasStore.getState();
    expect(loaded.nodes.map((node) => node.id)).toEqual([
      'frame',
      'note',
      'preview',
    ]);
    expect(loaded.nodes[0]).toMatchObject({ position: { x: 125, y: 236 } });
    expect(loaded.nodes[0]).not.toHaveProperty('parentId');
    expect(loaded.nodes[0]).not.toHaveProperty('extent');
    expect(loaded.nodes[1]).toMatchObject({
      parentId: 'frame',
      position: { x: 7, y: 8 },
      data: { content: 'Keep this note' },
    });
    expect(loaded.nodes[2]).toEqual(graph.nodes[5]);
    expect(loaded.edges).toEqual([graph.edges[1]]);
    expect(loaded.version).toBe(9);
    expect(JSON.stringify(graph)).toBe(before);
    expect(localStorage.getItem('legacy-topology-fixture')).toBe(before);
    expect(api.putCanvas).not.toHaveBeenCalled();
    expect(api.deleteNode).not.toHaveBeenCalled();
  });

  it('pastes surviving ordinary content and Space previews through the store entry', () => {
    useCanvasStore
      .getState()
      ._setStateNoAutosave({ canvasId: 'canvas-loaded' });
    const graph = storedGraph();
    const before = JSON.stringify(graph);
    useCanvasStore
      .getState()
      .pasteNodes({ x: 165, y: 276 }, graph.nodes, graph.edges);
    const pasted = useCanvasStore.getState();
    expect(pasted.nodes.map((node) => node.type)).toEqual([
      'frame',
      'note',
      'spacePreview',
    ]);
    expect(pasted.nodes[0].position).toEqual({ x: 165, y: 276 });
    expect(pasted.nodes[1].parentId).toBe(pasted.nodes[0].id);
    expect(pasted.edges).toHaveLength(1);
    expect(JSON.stringify(graph)).toBe(before);
    expect(api.deleteNode).not.toHaveBeenCalled();
  });

  it('drops stale preview tabs after a matching load without losing unbound chats', async () => {
    const preview = usePreviewWorkspaceStore.getState();
    preview.loadForCanvas('canvas-loaded');
    preview.openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-loaded',
      nodeId: 'ref',
    });
    preview.openPreviewTarget({
      kind: 'chat',
      canvasId: 'canvas-loaded',
      threadId: 'thread-keep',
    });
    api.getCanvas.mockResolvedValue({
      canvasId: 'canvas-loaded',
      title: 'Loaded',
      version: 9,
      state: storedGraph(),
    });

    await useCanvasStore.getState().loadCanvas('canvas-loaded');

    const targets = Object.values(
      usePreviewWorkspaceStore.getState().workspace.tabs,
    ).map((tab) => tab.target);
    expect(targets).not.toContainEqual({
      kind: 'node',
      canvasId: 'canvas-loaded',
      nodeId: 'ref',
    });
    expect(targets).toContainEqual({
      kind: 'chat',
      canvasId: 'canvas-loaded',
      threadId: 'thread-keep',
    });
  });
});
