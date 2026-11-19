// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listProfiles = vi.hoisted(() => vi.fn());
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/api/acp', () => ({ listAcpProfiles: listProfiles }));

import { toast } from '@/components/Common/Toast';

import { useAcpProfilesStore } from './acpProfilesStore';
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
import { useSettingsUiStore } from './settingsUiStore';

/** The action of the setup toast a missing Agent raised. */
function configureModelAction() {
  const action = vi.mocked(toast).mock.calls[0]?.[1]?.action;
  if (!action) throw new Error('Expected the setup toast');
  return action;
}

/** The node the workspace is showing; presentation moved off `canvasStore`. */
const expandedNodeId = () =>
  selectActiveNodeId(usePreviewWorkspaceStore.getState());

const profileSnapshot = {
  profiles: [
    {
      id: 'global-profile',
      alias: 'Global Profile',
      agentletId: 'machine',
      workingDirPath: '/workspace',
      launch: { kind: 'acp-command' as const, command: 'agent' },
    },
  ],
  selectableProfileIds: ['global-profile'],
  agentlet: null,
  agentDefaults: null,
};

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
    focusChatInputRequest: null,
  });
  useAcpProfilesStore.setState({
    profiles: [],
    selectableProfileIds: [],
    recentConversationProfileId: null,
    loaded: false,
    error: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(toast).mockClear();
  listProfiles.mockReset().mockResolvedValue(profileSnapshot);
  localStorage.clear();
  useSettingsUiStore.getState().close();
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

  it('offers setup without creating a fallback Chat', async () => {
    const unconfigured = {
      ...profileSnapshot,
      profiles: [],
      selectableProfileIds: [],
    };
    listProfiles.mockResolvedValue(unconfigured);
    const threads = useChatStore.getState().threadsById;
    expect(await openChat()).toBe('');
    expect(useChatStore.getState().threadsById).toBe(threads);
    expect(usePreviewWorkspaceStore.getState().workspace.tabs).toEqual({});
    expect(toast).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tone: 'info',
        action: expect.objectContaining({ label: 'Configure model' }),
        secondaryAction: expect.objectContaining({ label: 'Connect device' }),
      }),
    );
    expect(usePanelStore.getState().isRightCollapsed).toBe(true);
  });

  it('opens the requested Chat with Built-In Pi when the user configures a model', async () => {
    listProfiles.mockResolvedValue({
      ...profileSnapshot,
      profiles: [],
      selectableProfileIds: [],
    });
    expect(await openNewChat()).toBe('');
    configureModelAction().onClick();
    expect(useSettingsUiStore.getState()).toMatchObject({
      isOpen: true,
      requestedTab: 'builtIn',
    });
    await vi.waitFor(() =>
      expect(
        Object.values(usePreviewWorkspaceStore.getState().workspace.tabs),
      ).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ kind: 'chat' }),
        }),
      ]),
    );
  });

  it('does not open a Chat from a setup toast that outlived its Space', async () => {
    listProfiles.mockResolvedValue({
      ...profileSnapshot,
      profiles: [],
      selectableProfileIds: [],
    });
    expect(await openNewChat()).toBe('');
    useCanvasStore.getState()._setStateNoAutosave({ canvasId: 'other-canvas' });
    usePreviewWorkspaceStore.setState({ canvasId: 'other-canvas' });
    configureModelAction().onClick();
    await Promise.resolve();
    expect(listProfiles).toHaveBeenCalledOnce();
    expect(usePreviewWorkspaceStore.getState().workspace.tabs).toEqual({});
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
    resolve(profileSnapshot);
    expect(await pending).toBe('');
    expect(useChatStore.getState().threadsById).toBe(threads);
    expect(expandedNodeId()).toBe('node-note');
  });

  it('opens the right workspace with an explicitly expanded node', () => {
    openPreviewNode('node-note');

    expect(expandedNodeId()).toBe('node-note');
    expect(usePanelStore.getState()).toMatchObject({
      isRightCollapsed: false,
    });
  });

  it('browses nodes transiently by default without growing the tab strip', () => {
    const first = openPreviewNode('node-first');
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[first].transient,
    ).toBe(true);
    expect(openPreviewNode('node-first')).toBe(first);
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[first].transient,
    ).toBe(true);
    const second = openPreviewNode('node-second', {});
    expect(second).toBe(first);
    expect(expandedNodeId()).toBe('node-second');
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(1);
  });

  it('requires an explicit permanent open and preserves it during later browsing', () => {
    const kept = openPreviewNode('node-kept');
    expect(openPreviewNode('node-kept', { transient: false })).toBe(kept);
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[kept].transient,
    ).toBe(false);
    expect(openPreviewNode('node-kept')).toBe(kept);
    expect(
      usePreviewWorkspaceStore.getState().workspace.tabs[kept].transient,
    ).toBe(false);
    const inspection = openPreviewNode('node-inspection');
    expect(inspection).not.toBe(kept);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(2);
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
