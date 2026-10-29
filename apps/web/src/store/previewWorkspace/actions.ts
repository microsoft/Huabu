// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { toast } from '@/components/Common/Toast';
import { pageLifecycle } from '@/utils/pageLifecycle';

import { loadDefaultAgentBinding } from '../acpProfilesStore';
import useCanvasStore from '../canvasStore';
import { createConversation } from '../conversationPreparation';
import { usePanelStore } from '../panelStore';
import { findTabByTarget, groupOfTab, normalizePreviewTarget } from './model';
import { selectActiveTab, usePreviewWorkspaceStore } from './store';

export function openSpaceConversation(
  canvasId: string,
  nodeId: string,
  threadId: string,
): string {
  const preview = usePreviewWorkspaceStore.getState();
  usePanelStore.getState().requestOpenRightPanel();
  const tabId = preview.openPreviewTarget({
    kind: 'conversation',
    canvasId,
    nodeId,
    threadId,
  });
  preview.requestChatOpen(tabId, 'bottom');
  return tabId;
}

export function openPreviewNode(
  nodeId: string,
  options?: {
    transient?: boolean;
    focusEditor?: boolean;
    markReadIntent?: boolean;
  },
): string {
  const canvas = useCanvasStore.getState();
  usePanelStore.getState().requestOpenRightPanel();
  const tabId = usePreviewWorkspaceStore.getState().openPreviewTarget(
    { kind: 'node', canvasId: canvas.canvasId, nodeId },
    {
      transient: options?.transient ?? true,
      markReadIntent: options?.markReadIntent,
    },
  );
  const openedNode = canvas.nodes.find((node) => node.id === nodeId);
  if (tabId && openedNode?.type === 'note' && options?.focusEditor !== false) {
    usePreviewWorkspaceStore.getState().requestNodeFocus(tabId);
  } else if (tabId && options?.focusEditor === false) {
    const preview = usePreviewWorkspaceStore.getState();
    const request = preview.nodeFocusRequest;
    if (request?.tabId === tabId) {
      preview.consumeNodeFocusRequest(tabId, request.nonce);
    }
  }
  return tabId;
}

/** Opens the most recently used Chat, creating one when none exists. */
export async function openChat(): Promise<string> {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';

  const recentChat = Object.values(preview.workspace.tabs)
    .filter(
      (tab) => tab.target.kind === 'chat' && tab.target.canvasId === canvasId,
    )
    .sort((a, b) => b.lastActiveSeq - a.lastActiveSeq)[0];
  if (recentChat?.target.kind !== 'chat') return openNewChat();
  const threadId = recentChat.target.threadId;

  usePanelStore.getState().requestOpenRightPanel();
  const tabId = preview.openPreviewTarget({ kind: 'chat', canvasId, threadId });
  usePanelStore.getState().requestFocusChatInput(threadId);
  return tabId;
}

/** Creates a Chat only after defaults load, without stealing a changed UI. */
export async function openNewChat(groupId?: string): Promise<string> {
  const initial = usePreviewWorkspaceStore.getState();
  const canvasId = initial.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';
  try {
    return await pageLifecycle.run('updating', async () => {
      const binding = await loadDefaultAgentBinding();
      const preview = usePreviewWorkspaceStore.getState();
      if (
        useCanvasStore.getState().canvasId !== canvasId ||
        preview.canvasId !== initial.canvasId ||
        preview.workspace !== initial.workspace
      ) {
        return '';
      }
      const group = preview.workspace.groups.find(
        (entry) => entry.id === (groupId ?? preview.workspace.activeGroupId),
      );
      if (!group) return '';
      const threadId = createConversation({ canvasId, binding });
      usePanelStore.getState().requestOpenRightPanel();
      const tabId = preview.openPreviewTarget(
        { kind: 'chat', canvasId, threadId },
        { groupId: group.id },
      );
      usePanelStore.getState().requestFocusChatInput(threadId);
      return tabId;
    });
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), {
      tone: 'danger',
    });
    return '';
  }
}

/** Follow a document link without consuming its source inspection tab. */
export function openPreviewUrl(
  href: string,
  sourceNodeId?: string,
  sourceThreadId?: string,
): string {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId;
  if (!canvasId) return '';
  const target = normalizePreviewTarget({ kind: 'url', canvasId, url: href });
  if (!target) return '';
  const source = sourceNodeId
    ? findTabByTarget(preview.workspace, {
        kind: 'node',
        canvasId,
        nodeId: sourceNodeId,
      })
    : sourceThreadId
      ? (findTabByTarget(preview.workspace, {
          kind: 'chat',
          canvasId,
          threadId: sourceThreadId,
        }) ??
        Object.values(preview.workspace.tabs).find(
          (tab) =>
            tab.target.kind === 'conversation' &&
            tab.target.threadId === sourceThreadId,
        ))
      : null;
  const groupId = source
    ? groupOfTab(preview.workspace, source.id)?.id
    : undefined;
  if (source) {
    preview.promoteTab(source.id);
  }
  usePanelStore.getState().requestOpenRightPanel();
  return preview.openPreviewTarget(target, { groupId });
}

export function closeActivePreviewNode(): void {
  const preview = usePreviewWorkspaceStore.getState();
  const activeTab = selectActiveTab(preview);
  if (!activeTab) return;
  const target = activeTab?.target;
  if (target?.kind !== 'node') return;

  preview.closeTab(activeTab.id);
}
