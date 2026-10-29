// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import useCanvasStore from '@/store/canvasStore';
import { acknowledgeConversationResult } from '@/store/conversationOwner';
import { useDesktopTabStore } from '@/store/desktopTabStore';
import { usePanelStore } from '@/store/panelStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import {
  isActivelyViewingQuestion,
  useActivelyViewingQuestionNode,
} from './useActivelyViewingQuestion';

import type * as CanvasApi from '@/api/canvas';

const environment = vi.hoisted(() => ({ desktop: false }));
const acknowledge = vi.hoisted(() => vi.fn());
vi.mock('@/api/canvas', async (importOriginal) => ({
  ...(await importOriginal<typeof CanvasApi>()),
  acknowledgeAgentNodeResult: acknowledge,
}));
vi.mock('./useElectron', () => ({
  getElectronBridge: () =>
    environment.desktop ? { tabs: { context: { role: 'space' } } } : undefined,
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  environment.desktop = false;
  acknowledge.mockReset().mockResolvedValue({ acknowledged: true });
  useDesktopTabStore.setState({ isActive: false });
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
  it('does not consider an inactive desktop Space actively viewed', () => {
    environment.desktop = true;
    usePreviewWorkspaceStore.getState().openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'question-2',
    });
    expect(isActivelyViewingQuestion({ nodeId: 'question-2' })).toBe(false);
    expect(isActivelyViewingQuestion({ threadId: 'thread-2' })).toBe(false);
    useDesktopTabStore.setState({ isActive: true });
    expect(isActivelyViewingQuestion({ nodeId: 'question-2' })).toBe(true);
  });

  it('leaves background completion unread until its Space is activated', async () => {
    environment.desktop = true;
    usePreviewWorkspaceStore.getState().openPreviewTarget({
      kind: 'node',
      canvasId: 'canvas-1',
      nodeId: 'question-2',
    });
    function Harness({ done }: { done: boolean }) {
      const active = useActivelyViewingQuestionNode('question-2');
      useEffect(() => {
        if (done && active)
          void acknowledgeConversationResult(
            {
              presentationAnchor: {
                canvasId: 'canvas-1',
                nodeId: 'question-2',
              },
              conversationOwner: {
                canvasId: 'canvas-1',
                nodeId: 'question-2',
                threadId: 'thread-2',
              },
            },
            { status: 'done', viewed: false, invocationToken: 'completed-run' },
          );
      }, [done, active]);
      return null;
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(createElement(Harness, { done: false })),
      );
      await act(async () =>
        root.render(createElement(Harness, { done: true })),
      );
      expect(acknowledge).not.toHaveBeenCalled();
      await act(async () => useDesktopTabStore.setState({ isActive: true }));
      expect(acknowledge).toHaveBeenCalledExactlyOnceWith(
        'canvas-1',
        'question-2',
        { invocationToken: 'completed-run' },
      );
      expect(
        usePreviewWorkspaceStore.getState().workspace.groups[0].activeTabId,
      ).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

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

  it('recognizes the original thread in a remote preview without an active Canvas node', () => {
    usePreviewWorkspaceStore.getState().openPreviewTarget({
      kind: 'conversation',
      canvasId: 'child',
      nodeId: 'remote-agent',
      threadId: 'remote-thread',
    });
    expect(isActivelyViewingQuestion({ threadId: 'remote-thread' })).toBe(true);
    expect(isActivelyViewingQuestion({ nodeId: 'remote-agent' })).toBe(true);
    usePanelStore.setState({ isRightCollapsed: true });
    expect(isActivelyViewingQuestion({ threadId: 'remote-thread' })).toBe(
      false,
    );
  });
});
