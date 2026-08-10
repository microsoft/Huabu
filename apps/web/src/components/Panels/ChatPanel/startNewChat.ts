// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useChatStore } from '@/store/chatStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import type { AgentBinding, AgentMode } from '@huabu/shared';

type StartNewChatOptions = {
  embedded: boolean;
  canvasId: string;
  choice: { binding: AgentBinding; mode: AgentMode };
};

/** Routes new-chat creation through the active presentation mode. */
export function startNewChat({
  embedded,
  canvasId,
  choice,
}: StartNewChatOptions): string {
  const chatStore = useChatStore.getState();
  if (!embedded) {
    chatStore.clearMessages(canvasId || undefined, {
      ...(choice.binding.kind === 'external'
        ? { binding: choice.binding }
        : {}),
      lastAction: choice.mode,
    });
    return useChatStore.getState().threadId;
  }

  const threadId = chatStore.createThread({
    binding: choice.binding,
    lastAction: choice.mode,
  });
  usePreviewWorkspaceStore.getState().openPreviewTarget({
    kind: 'chat',
    canvasId,
    threadId,
  });
  return threadId;
}
