// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectThreadBinding,
  selectThreadHistoryLoaded,
  selectThreadLastAction,
  selectThreadMessages,
  useChatStore,
} from '@/store/chatStore';
import { createEmptyWorkspace } from '@/store/previewWorkspace/model';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { startNewChat } from './startNewChat';

import type { AgentBinding } from '@huabu/shared';

const CANVAS_ID = 'canvas-1';
const OLD_THREAD_ID = 'thread-old';
const EXTERNAL: AgentBinding = {
  kind: 'external',
  alias: 'Claude Code',
  profileId: 'profile-1',
};

beforeEach(() => {
  useChatStore.setState({
    threadsById: {},
    threadId: OLD_THREAD_ID,
    lastActionByThread: {},
    threadMap: {},
    bindingMap: {},
  });
  usePreviewWorkspaceStore.setState({
    canvasId: CANVAS_ID,
    workspace: createEmptyWorkspace('group-1'),
  });
});

describe('startNewChat', () => {
  it('opens an independent workspace tab and preserves the previous history', () => {
    const chatStore = useChatStore.getState();
    chatStore.setMessages(OLD_THREAD_ID, [
      { id: 'message-1', role: 'user', content: 'Keep this conversation' },
    ]);
    usePreviewWorkspaceStore.getState().openPreviewTarget({
      kind: 'chat',
      canvasId: CANVAS_ID,
      threadId: OLD_THREAD_ID,
    });

    const newThreadId = startNewChat({
      embedded: true,
      canvasId: CANVAS_ID,
      choice: { binding: EXTERNAL, mode: 'operate' },
    });

    const chatState = useChatStore.getState();
    const workspace = usePreviewWorkspaceStore.getState().workspace;
    const group = workspace.groups[0];
    expect(newThreadId).not.toBe(OLD_THREAD_ID);
    expect(chatState.threadId).toBe(OLD_THREAD_ID);
    expect(selectThreadMessages(chatState, OLD_THREAD_ID)).toHaveLength(1);
    expect(selectThreadMessages(chatState, newThreadId)).toEqual([]);
    expect(selectThreadHistoryLoaded(chatState, newThreadId)).toBe(true);
    expect(selectThreadBinding(chatState, newThreadId)).toEqual(EXTERNAL);
    expect(selectThreadLastAction(chatState, newThreadId)).toBe('operate');
    expect(group.tabIds).toHaveLength(2);
    expect(workspace.tabs[group.activeTabId ?? '']?.target).toEqual({
      kind: 'chat',
      canvasId: CANVAS_ID,
      threadId: newThreadId,
    });
  });

  it('keeps replacing the global thread in the legacy presentation', () => {
    const newThreadId = startNewChat({
      embedded: false,
      canvasId: CANVAS_ID,
      choice: { binding: EXTERNAL, mode: 'operate' },
    });

    expect(useChatStore.getState().threadId).toBe(newThreadId);
    expect(
      Object.keys(usePreviewWorkspaceStore.getState().workspace.tabs),
    ).toHaveLength(0);
  });
});
