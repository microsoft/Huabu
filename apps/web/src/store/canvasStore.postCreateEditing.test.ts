// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from './canvasStore';
import { usePanelStore } from './panelStore';
import {
  closeActivePreviewNode,
  openChat,
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
    pendingInlineEditNodeId: null,
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'test-canvas',
    workspace: createEmptyWorkspace(),
    nodeFocusRequest: null,
    nodeFocusRequestSeq: 0,
  });
  usePanelStore.setState({
    isRightCollapsed: true,
    rightPanelAnchorNodeId: null,
    focusChatInputRequest: null,
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
  it('creates and focuses Chat without acting as a panel toggle', () => {
    const tabId = openChat();
    const tab = usePreviewWorkspaceStore.getState().workspace.tabs[tabId];

    expect(tab.target.kind).toBe('chat');
    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
      focusChatInputRequest: {
        threadId: tab.target.kind === 'chat' ? tab.target.threadId : undefined,
      },
    });

    openChat();

    expect(usePanelStore.getState().isRightCollapsed).toBe(false);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(1);
  });

  it('focuses the most recently active existing Chat', () => {
    const preview = usePreviewWorkspaceStore.getState();
    const first = preview.openPreviewTarget({
      kind: 'chat',
      canvasId: 'test-canvas',
      threadId: 'thread-first',
    });
    const second = preview.openPreviewTarget({
      kind: 'chat',
      canvasId: 'test-canvas',
      threadId: 'thread-second',
    });
    preview.activateTab(first);
    preview.openPreviewTarget({
      kind: 'node',
      canvasId: 'test-canvas',
      nodeId: 'node-note',
    });

    expect(openChat()).toBe(first);
    expect(
      usePreviewWorkspaceStore.getState().workspace.groups[0].activeTabId,
    ).toBe(first);
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[second],
    ).toBeDefined();
  });

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
      inputs: [
        {
          id: 'node-note',
          nodeType: 'note',
          data: { origin: { type: 'user-created' } },
        },
      ],
    });

    const activeTabId =
      usePreviewWorkspaceStore.getState().workspace.groups[0].activeTabId;
    expect(expandedNodeId()).toBe('node-note');
    expect(usePreviewWorkspaceStore.getState().nodeFocusRequest).toMatchObject({
      tabId: activeTabId,
    });
    expect(useCanvasStore.getState().pendingInlineEditNodeId).toBeNull();
  });

  it('requests inline editing for a newly created text node', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [
        {
          id: 'node-text',
          nodeType: 'text',
          data: { origin: { type: 'user-created' } },
        },
      ],
    });

    const state = useCanvasStore.getState();
    expect(expandedNodeId()).toBeNull();
    expect(state.pendingInlineEditNodeId).toBe('node-text');
  });

  it('keeps an excerpt-created note on the Canvas without opening it', () => {
    useCanvasStore.getState().dispatchUiIntent({
      type: 'ADD_NODES',
      inputs: [
        {
          id: 'node-excerpt',
          nodeType: 'note',
          data: { origin: { type: 'user-excerpt' } },
        },
      ],
    });

    const state = useCanvasStore.getState();
    expect(expandedNodeId()).toBeNull();
    expect(state.pendingInlineEditNodeId).toBeNull();
    expect(
      state.nodes.find((node) => node.id === 'node-excerpt'),
    ).toBeDefined();
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
