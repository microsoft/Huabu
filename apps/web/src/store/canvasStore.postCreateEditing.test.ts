// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/api/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof AcpApi>()),
  listAcpProfiles: listProfiles,
}));

import { toast } from '@/components/Common/Toast';

import useCanvasStore from './canvasStore';
import { useChatStore } from './chatStore';
import { usePanelStore } from './panelStore';
import {
  closeActivePreviewNode,
  openChat,
  openNewChat,
  openPreviewNode,
} from './previewWorkspace/actions';
import { createEmptyWorkspace } from './previewWorkspace/model';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from './previewWorkspace/store';

import type * as AcpApi from '@/api/acp';

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
  vi.mocked(toast).mockClear();
  listProfiles.mockResolvedValue({
    profiles: [],
    selectableProfileIds: [],
    agentlet: null,
    agentDefaults: { profileId: 'global-profile', functionalModel: '' },
  });
  resetStore();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('post-create editing', () => {
  it('creates and focuses Chat without acting as a panel toggle', async () => {
    const tabId = await openChat();
    const tab = usePreviewWorkspaceStore.getState().workspace.tabs[tabId];

    expect(tab.target.kind).toBe('chat');
    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
      focusChatInputRequest: {
        threadId: tab.target.kind === 'chat' ? tab.target.threadId : undefined,
      },
    });

    await openChat();

    expect(usePanelStore.getState().isRightCollapsed).toBe(false);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(1);
  });

  it('focuses the most recently active existing Chat', async () => {
    listProfiles.mockClear();
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

    expect(await openChat()).toBe(first);
    expect(
      usePreviewWorkspaceStore.getState().workspace.groups[0].activeTabId,
    ).toBe(first);
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[second],
    ).toBeDefined();
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('prompts to configure defaults without creating a fallback Chat', async () => {
    listProfiles.mockResolvedValueOnce({
      profiles: [],
      selectableProfileIds: [],
      agentlet: null,
    });
    const threads = useChatStore.getState().threadsById;
    expect(await openChat()).toBe('');
    expect(useChatStore.getState().threadsById).toBe(threads);
    expect(usePreviewWorkspaceStore.getState().workspace.tabs).toEqual({});
    expect(toast).toHaveBeenCalledWith(expect.any(String), { tone: 'danger' });
    expect(usePanelStore.getState().isRightCollapsed).toBe(true);
  });

  it('does not open a delayed Chat in a different Canvas or changed workspace', async () => {
    let resolve!: (value: unknown) => void;
    listProfiles.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const threads = useChatStore.getState().threadsById;
    const pending = openNewChat();
    openPreviewNode('node-note');
    resolve({
      profiles: [],
      selectableProfileIds: [],
      agentlet: null,
      agentDefaults: { profileId: 'global-profile', functionalModel: '' },
    });
    expect(await pending).toBe('');
    expect(useChatStore.getState().threadsById).toBe(threads);
    expect(expandedNodeId()).toBe('node-note');
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
