// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';
import { usePanelStore } from './panelStore';
import {
  closeActivePreviewNode,
  openPreviewNode,
} from './previewWorkspace/actions';
import { createEmptyWorkspace } from './previewWorkspace/model';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from './previewWorkspace/store';

/** The node the workspace is showing; presentation moved off `canvasStore`. */
const expandedNodeId = () =>
  selectActiveNodeId(usePreviewWorkspaceStore.getState());

function resetStore() {
  useCanvasStore.getState()._setStateNoAutosave({
    nodes: [],
    edges: [],
    canvasId: 'test-canvas',
    isLoading: true,
    expandedNodeFocusTick: 0,
    pendingInlineEditNodeId: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'test-canvas',
    workspace: createEmptyWorkspace(),
  });
  usePanelStore.setState({
    isRightCollapsed: true,
    rightPanelAnchorNodeId: null,
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
  it('opens the right workspace with an explicitly expanded node', () => {
    openPreviewNode('node-note');

    expect(expandedNodeId()).toBe('node-note');
    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
      rightPanelAnchorNodeId: 'node-note',
    });
  });

  it('closes the node preview without collapsing the workspace', () => {
    openPreviewNode('node-note');
    closeActivePreviewNode();

    expect(expandedNodeId()).toBeNull();
    expect(usePanelStore.getState().isRightCollapsed).toBe(false);
  });

  it('opens a newly created note in expanded editing view', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [{ id: 'node-note', nodeType: 'note' }],
    });

    const state = useCanvasStore.getState();
    expect(expandedNodeId()).toBe('node-note');
    expect(state.expandedNodeFocusTick).toBe(1);
    expect(state.pendingInlineEditNodeId).toBeNull();
  });

  it('requests inline editing for a newly created text node', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [{ id: 'node-text', nodeType: 'text' }],
    });

    const state = useCanvasStore.getState();
    expect(expandedNodeId()).toBeNull();
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
    expect(expandedNodeId()).toBeNull();
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
    expect(expandedNodeId()).toBeNull();
    expect(state.pendingInlineEditNodeId).toBeNull();
  });
});
