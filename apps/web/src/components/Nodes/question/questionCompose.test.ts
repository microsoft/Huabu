// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
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
  });

  it('opens Question compose as a workspace tab and focuses its thread', () => {
    enterQuestionCompose(view, 'canvas-1');

    expect(selectActiveNodeId(usePreviewWorkspaceStore.getState())).toBe(
      'question-1',
    );
    expect(usePanelStore.getState().focusChatInputRequest?.threadId).toBe(
      'thread-1',
    );
  });
});
