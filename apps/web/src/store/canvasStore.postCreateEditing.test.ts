// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';

function resetStore() {
  useCanvasStore.getState()._setStateNoAutosave({
    nodes: [],
    edges: [],
    canvasId: 'test-canvas',
    isLoading: true,
    expandedNodeId: null,
    expandedNodeFocusTick: 0,
    pendingInlineEditNodeId: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('post-create editing', () => {
  it('opens a newly created note in expanded editing view', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [{ id: 'node-note', nodeType: 'note' }],
    });

    const state = useCanvasStore.getState();
    expect(state.expandedNodeId).toBe('node-note');
    expect(state.expandedNodeFocusTick).toBe(1);
    expect(state.pendingInlineEditNodeId).toBeNull();
  });

  it('requests inline editing for a newly created text node', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [{ id: 'node-text', nodeType: 'text' }],
    });

    const state = useCanvasStore.getState();
    expect(state.expandedNodeId).toBeNull();
    expect(state.pendingInlineEditNodeId).toBe('node-text');
  });

  it('does not request editing for non-UI node creation', () => {
    useCanvasStore.getState().executeCommands(
      [
        {
          type: 'CREATE_NODES',
          nodes: [
            {
              id: 'node-agent',
              nodeType: 'note',
              position: { x: 0, y: 0 },
            },
          ],
        },
      ],
      'agent',
    );

    const state = useCanvasStore.getState();
    expect(state.expandedNodeId).toBeNull();
    expect(state.pendingInlineEditNodeId).toBeNull();
  });

  it('does not edit an existing node when creation is rejected', () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'node-existing',
          type: 'note',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });

    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [{ id: 'node-existing', nodeType: 'note' }],
    });

    const state = useCanvasStore.getState();
    expect(state.expandedNodeId).toBeNull();
    expect(state.pendingInlineEditNodeId).toBeNull();
  });
});
