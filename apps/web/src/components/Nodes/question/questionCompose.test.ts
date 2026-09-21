// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { assert, beforeEach, describe, expect, it, vi } from 'vitest';

const saveDraft = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const associateNode = vi.hoisted(() => vi.fn());
const listProfiles = vi.hoisted(() => vi.fn());
vi.mock('@/api/acp', async (importOriginal) => ({
  ...(await importOriginal<typeof AcpApi>()),
  listAcpProfiles: listProfiles,
}));
vi.mock('@/components/Common/Toast', () => ({ toast: vi.fn() }));
vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  associateAgentNode: associateNode,
}));
vi.mock('@/store/conversationOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationOwner>()),
  saveConversationDraft: saveDraft,
}));

import { toast } from '@/components/Common/Toast';
import { useAcpProfilesStore } from '@/store/acpProfilesStore';
import useCanvasStore from '@/store/canvasStore';
import {
  selectThreadBinding,
  selectThreadLastAction,
  useChatStore,
} from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import {
  selectActiveNodeId,
  usePreviewWorkspaceStore,
} from '@/store/previewWorkspace/store';

import {
  createQuestionNode,
  createQuestionNodeAndCompose,
  enterQuestionCompose,
  enterQuestionConversation,
  ensureQuestionThread,
} from './questionCompose';

import type * as AcpApi from '@/api/acp';
import type * as CanvasApi from '@/api/canvas';
import type * as ConversationOwner from '@/store/conversationOwner';

const view = {
  presentationAnchor: { canvasId: 'canvas-1', nodeId: 'question-1' },
  conversationOwner: {
    canvasId: 'canvas-1',
    nodeId: 'question-1',
    threadId: 'thread-1',
  },
};

beforeEach(() => {
  saveDraft.mockClear();
  associateNode.mockReset();
  listProfiles.mockReset().mockResolvedValue({
    profiles: [],
    selectableProfileIds: [],
    agentlet: null,
    agentDefaults: {
      profileId: 'global-profile',
      functionalModel: 'utility-model',
    },
  });
  useAcpProfilesStore.setState({
    loaded: false,
    error: null,
    profiles: [],
    agentDefaults: null,
  });
  vi.mocked(toast).mockClear();
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    nodes: [],
    edges: [],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'canvas-1',
    workspace: createEmptyWorkspace(),
  });
  useChatStore.setState({
    threadsById: {},
    bindingMap: {},
    bindingByThread: {},
    lastActionByThread: {},
    settingsByThread: {},
    ephemeralMetadataThreads: {},
  });
  usePanelStore.setState({
    isRightCollapsed: true,
    rightPanelAnchorNodeId: null,
    focusChatInputRequest: null,
  });
});

describe('Question conversation presentation', () => {
  it('keeps legacy compose by awaiting a server-minted identity', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      version: 1,
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: { content: '' },
        },
      ],
    });
    associateNode.mockResolvedValue({
      fromVersion: 1,
      toVersion: 2,
      node: {
        id: 'question-1',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { threadId: 'thread-legacy', bindingState: 'editing' },
      },
    });
    expect(await ensureQuestionThread('canvas-1', 'question-1')).toBe(
      'thread-legacy',
    );
    expect(associateNode).toHaveBeenCalledWith('canvas-1', 'question-1', {
      kind: 'initialize',
    });
    expect(useCanvasStore.getState().nodes[0].data).toMatchObject({
      threadId: 'thread-legacy',
      bindingState: 'editing',
    });
    expect(await ensureQuestionThread('canvas-1', 'question-1')).toBe(
      'thread-legacy',
    );
    expect(associateNode).toHaveBeenCalledOnce();
  });

  it('does not invent an identity when the association is rejected', async () => {
    useCanvasStore.getState()._setStateNoAutosave({
      nodes: [
        {
          id: 'question-1',
          type: 'question',
          position: { x: 0, y: 0 },
          data: {},
        },
      ],
    });
    associateNode.mockRejectedValue(new Error('Identity is missing'));
    await expect(
      ensureQuestionThread('canvas-1', 'question-1'),
    ).rejects.toThrow('Identity is missing');
    expect(useCanvasStore.getState().nodes[0].data.threadId).toBeUndefined();
  });

  it('creates an explicitly bound empty Ink question without opening Chat', () => {
    const addNode = vi.fn();
    const created = createQuestionNode({
      addNode,
      canvasId: 'canvas-1',
      placementPoint: { x: 10, y: 20 },
      binding: { kind: 'internal' },
      mode: 'operate',
      label: 'New ink request',
      pendingInkIntentLabel: true,
    });
    expect(addNode).toHaveBeenCalledWith(
      expect.objectContaining({
        id: created.nodeId,
        data: expect.objectContaining({
          content: '',
          threadId: created.threadId,
          agentBinding: { kind: 'internal' },
          agentMode: 'operate',
          label: 'New ink request',
          pendingInkIntentLabel: true,
        }),
      }),
    );
    expect(usePanelStore.getState().isRightCollapsed).toBe(true);
    expect(usePanelStore.getState().focusChatInputRequest).toBeNull();
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(0);
    expect(
      selectThreadBinding(useChatStore.getState(), created.threadId),
    ).toEqual({ kind: 'internal' });
  });

  it('creates and focuses the global default instead of inheriting the Canvas selection', async () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-1',
      alias: 'Agent',
    };
    useChatStore.setState({ bindingMap: { 'canvas-1': binding } });
    const addNode = vi.fn();
    const created = await createQuestionNodeAndCompose({
      addNode,
      canvasId: 'canvas-1',
      placementPoint: { x: 0, y: 0 },
    });
    assert(created);
    expect(usePanelStore.getState().isRightCollapsed).toBe(false);
    expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
      created.threadId,
    );
    expect(
      selectThreadBinding(useChatStore.getState(), created.threadId),
    ).toEqual({
      kind: 'external',
      profileId: 'global-profile',
      alias: 'global-profile',
    });
    expect(addNode).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          agentBinding: {
            kind: 'external',
            profileId: 'global-profile',
            alias: 'global-profile',
          },
          agentMode: 'ask',
        }),
      }),
    );
  });

  it('does not create or open a node when defaults are unconfigured', async () => {
    listProfiles.mockResolvedValueOnce({
      profiles: [],
      selectableProfileIds: [],
      agentlet: null,
      agentDefaults: { profileId: null, functionalModel: '' },
    });
    const addNode = vi.fn();
    expect(
      await createQuestionNodeAndCompose({
        addNode,
        canvasId: 'canvas-1',
        placementPoint: { x: 0, y: 0 },
      }),
    ).toBeNull();
    expect(addNode).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.any(String), { tone: 'danger' });
    expect(useChatStore.getState().threadsById).toEqual({});
    expect(usePanelStore.getState().isRightCollapsed).toBe(true);
  });

  it('discards delayed creation after the Canvas changes', async () => {
    let resolve!: (value: unknown) => void;
    listProfiles.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const addNode = vi.fn();
    const pending = createQuestionNodeAndCompose({
      addNode,
      canvasId: 'canvas-1',
      placementPoint: { x: 0, y: 0 },
    });
    useCanvasStore.setState({ canvasId: 'canvas-2' });
    resolve({
      profiles: [],
      selectableProfileIds: [],
      agentlet: null,
      agentDefaults: { profileId: 'global-profile', functionalModel: '' },
    });
    expect(await pending).toBeNull();
    expect(addNode).not.toHaveBeenCalled();
  });

  it('does not create a connected node after its caller scope disappears', async () => {
    const addNode = vi.fn();
    expect(
      await createQuestionNodeAndCompose({
        addNode,
        canvasId: 'canvas-1',
        placementPoint: { x: 0, y: 0 },
        isCurrent: () => false,
      }),
    ).toBeNull();
    expect(addNode).not.toHaveBeenCalled();
    expect(useChatStore.getState().threadsById).toEqual({});
  });

  it('opens an authored Question as a workspace node tab', () => {
    enterQuestionConversation(view, undefined, 'canvas-1', 'bottom');

    expect(selectActiveNodeId(usePreviewWorkspaceStore.getState())).toBe(
      'question-1',
    );
    expect(usePanelStore.getState().isRightCollapsed).toBe(false);
    expect(usePreviewWorkspaceStore.getState().chatOpenRequest).toMatchObject({
      position: 'bottom',
    });
  });

  it.each([
    { kind: 'internal' as const },
    { kind: 'external' as const, profileId: 'chosen', alias: 'Chosen Agent' },
  ])(
    'preserves the existing node selection %o despite a different global default',
    (binding) => {
      useAcpProfilesStore.setState({
        loaded: true,
        agentDefaults: {
          profileId: 'global-profile',
          functionalModel: 'utility-model',
        },
      });
      useCanvasStore.setState({
        nodes: [
          {
            id: 'question-1',
            type: 'question',
            position: { x: 0, y: 0 },
            data: {
              threadId: 'thread-1',
              agentBinding: binding,
              agentMode: 'ask',
            },
          },
        ],
      });
      enterQuestionCompose(view, 'canvas-1');
      expect(selectThreadBinding(useChatStore.getState(), 'thread-1')).toEqual(
        binding,
      );
      expect(selectThreadLastAction(useChatStore.getState(), 'thread-1')).toBe(
        'ask',
      );
      expect(saveDraft).not.toHaveBeenCalled();
      expect(listProfiles).not.toHaveBeenCalled();
    },
  );

  it('opens an authored Question transiently when requested by inspection', () => {
    enterQuestionConversation(view, undefined, 'canvas-1', 'bottom', {
      transient: true,
    });

    const activeTab = Object.values(
      usePreviewWorkspaceStore.getState().workspace.tabs,
    )[0];
    expect(activeTab.transient).toBe(true);
  });

  it('opens Question compose as a workspace tab and focuses its thread', () => {
    enterQuestionCompose(view, 'canvas-1');

    expect(selectActiveNodeId(usePreviewWorkspaceStore.getState())).toBe(
      'question-1',
    );
    expect(selectThreadLastAction(useChatStore.getState(), 'thread-1')).toBe(
      'operate',
    );
    expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
      'thread-1',
    );
  });

  it('opens Question compose transiently when requested by inspection', () => {
    enterQuestionCompose(view, 'canvas-1', undefined, { transient: true });

    const activeTab = Object.values(
      usePreviewWorkspaceStore.getState().workspace.tabs,
    )[0];
    expect(activeTab.transient).toBe(true);
  });

  it('preserves legacy internal Question identity instead of inheriting a Canvas binding', () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-1',
      alias: 'Research agent',
    };
    useChatStore.setState({ bindingMap: { 'canvas-1': binding } });

    enterQuestionCompose(view, 'canvas-1');

    expect(selectThreadBinding(useChatStore.getState(), 'thread-1')).toEqual({
      kind: 'internal',
    });
    expect(saveDraft).toHaveBeenCalledWith(view, {
      agentBinding: { kind: 'internal' },
      agentMode: 'operate',
    });
  });
});
