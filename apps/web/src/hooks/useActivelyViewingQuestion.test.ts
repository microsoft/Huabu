// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { isActivelyViewingQuestion } from './useActivelyViewingQuestion';

beforeEach(() => {
  useCanvasStore.getState()._setStateNoAutosave({
    canvasId: 'canvas-1',
    nodes: [
      {
        id: 'question-1',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { threadId: 'thread-1' },
      },
      {
        id: 'question-2',
        type: 'question',
        position: { x: 0, y: 0 },
        data: { threadId: 'thread-2' },
      },
    ],
    edges: [],
  });
  usePreviewWorkspaceStore.setState({
    canvasId: 'canvas-1',
    workspace: createEmptyWorkspace('group-1'),
  });
  usePanelStore.setState({ isRightCollapsed: false });
});

describe('isActivelyViewingQuestion', () => {
  it('matches only the active tab in each group', () => {
    const preview = usePreviewWorkspaceStore.getState();
    preview.openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'question-1',
    });
    preview.openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'question-2',
    });

    expect(isActivelyViewingQuestion({ nodeId: 'question-1' })).toBe(false);
    expect(isActivelyViewingQuestion({ threadId: 'thread-1' })).toBe(false);
    expect(isActivelyViewingQuestion({ nodeId: 'question-2' })).toBe(true);
    expect(isActivelyViewingQuestion({ threadId: 'thread-2' })).toBe(true);
  });

  it('treats a collapsed panel as not actively viewed', () => {
    usePreviewWorkspaceStore.getState().openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'question-2',
    });
    usePanelStore.setState({ isRightCollapsed: true });

    expect(isActivelyViewingQuestion({ nodeId: 'question-2' })).toBe(false);
  });
});
