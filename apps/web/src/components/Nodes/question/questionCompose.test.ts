// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const saveDraft = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const associateNode = vi.hoisted(() => vi.fn());
vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  associateAgentNode: associateNode,
}));
vi.mock('@/store/conversationOwner', async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationOwner>()),
  saveConversationDraft: saveDraft,
}));

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
  enterQuestionCompose,
  enterQuestionConversation,
  ensureQuestionThread,
} from './questionCompose';

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
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    nodes: [],
    edges: [],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'canvas-1',
    workspace: createEmptyWorkspace(),
  });
  useChatStore.setState({ threadsById: {}, bindingMap: {} });
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

  it('inherits the Canvas binding for a new Question thread', () => {
    const binding = {
      kind: 'external' as const,
      profileId: 'profile-1',
      alias: 'Research agent',
    };
    useChatStore.setState({ bindingMap: { 'canvas-1': binding } });

    enterQuestionCompose(view, 'canvas-1');

    expect(selectThreadBinding(useChatStore.getState(), 'thread-1')).toEqual(
      binding,
    );
    expect(saveDraft).toHaveBeenCalledWith(view, {
      agentBinding: binding,
      agentMode: 'ask',
      agentIcon: expect.objectContaining({ shape: expect.any(String) }),
    });
  });
});
