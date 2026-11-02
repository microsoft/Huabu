// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { dismissToast, toast } from '@/components/Common/Toast';
import { i18n } from '@/i18n';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore, selectThreadQuotedComments } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';
import { openPreviewNode } from '@/store/previewWorkspace/actions';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import type { AgentConversationView } from '@huabu/shared';

const pendingNotifications = new Map<string, () => void>();

export function revealQuotedCommentDraft(
  view: AgentConversationView,
  title: string,
) {
  const { canvasId, nodeId, threadId } = view.conversationOwner;
  const key = `${canvasId}\0${threadId}`;
  pendingNotifications.get(key)?.();
  const preview = usePreviewWorkspaceStore.getState();
  const visible =
    preview.canvasId === canvasId &&
    !usePanelStore.getState().isRightCollapsed &&
    preview.workspace.groups.some((group) => {
      const target = group.activeTabId
        ? preview.workspace.tabs[group.activeTabId]?.target
        : undefined;
      return (
        target?.canvasId === canvasId &&
        ((target.kind === 'node' && target.nodeId === nodeId) ||
          (target.kind === 'chat' && target.threadId === threadId))
      );
    });
  if (visible) {
    usePanelStore.getState().requestFocusChatInput(threadId);
    return;
  }
  const draftIds = new Set(
    selectThreadQuotedComments(useChatStore.getState(), threadId).map(
      (item) => item.draftId,
    ),
  );
  const validOwner = () => {
    const canvas = useCanvasStore.getState();
    return (
      canvas.canvasId === canvasId &&
      canvas.nodes.some(
        (node) =>
          node.type === 'question' &&
          node.id === nodeId &&
          node.data.threadId === threadId,
      ) &&
      !canvas.pendingForkThreadIds[threadId]
    );
  };
  const hasDraft = () =>
    selectThreadQuotedComments(useChatStore.getState(), threadId).some((item) =>
      draftIds.has(item.draftId),
    );
  const id = toast(i18n.t('messages.commentStaged', { title }), {
    duration: 0,
    action: {
      label: i18n.t('messages.viewCommentInput'),
      onClick: () => {
        if (!validOwner() || !hasDraft()) {
          toast(i18n.t('messages.commentDestinationUnavailable'), {
            tone: 'warning',
          });
        } else {
          const tabId = openPreviewNode(nodeId, {
            transient: false,
            focusEditor: false,
          });
          usePreviewWorkspaceStore.getState().requestChatOpen(tabId, 'bottom');
          usePanelStore.getState().requestFocusChatInput(threadId);
        }
        cleanup();
      },
    },
  });
  const onChange = () => {
    if (!validOwner() || !hasDraft()) cleanup();
  };
  const unsubscribeChat = useChatStore.subscribe(onChange);
  const unsubscribeCanvas = useCanvasStore.subscribe(onChange);
  const cleanup = () => {
    dismissToast(id);
    unsubscribeChat();
    unsubscribeCanvas();
    pendingNotifications.delete(key);
  };
  pendingNotifications.set(key, cleanup);
}
