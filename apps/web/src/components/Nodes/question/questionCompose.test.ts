// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

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
} from './questionCompose';

const view = {
  presentationAnchor: { canvasId: 'canvas-1', nodeId: 'question-1' },
  conversationOwner: {
    canvasId: 'canvas-1',
    nodeId: 'question-1',
    threadId: 'thread-1',
  },
};

beforeEach(() => {
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
  });
});
