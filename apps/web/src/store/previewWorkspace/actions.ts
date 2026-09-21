// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { toast } from '@/components/Common/Toast';

import { loadDefaultAgentBinding } from '../acpProfilesStore';
import useCanvasStore, { settleNodePreprocess } from '../canvasStore';
import { useChatStore } from '../chatStore';
import { usePanelStore } from '../panelStore';
import { findTabByTarget, groupOfTab, normalizePreviewTarget } from './model';
import {
  selectActiveNodeId,
  selectActiveTab,
  usePreviewWorkspaceStore,
} from './store';

export function openPreviewNode(
  nodeId: string,
  options?: { transient?: boolean },
): string {
  const canvas = useCanvasStore.getState();
  const previousNodeId = selectActiveNodeId(
    usePreviewWorkspaceStore.getState(),
  );
  if (previousNodeId && previousNodeId !== nodeId) {
    const previous = canvas.nodes.find((node) => node.id === previousNodeId);
    if (previous?.type === 'note' || previous?.type === 'text') {
      settleNodePreprocess(previousNodeId);
    }
  }

  usePanelStore.getState().requestOpenRightPanel(nodeId);
  const tabId = usePreviewWorkspaceStore
    .getState()
    .openPreviewTarget(
      { kind: 'node', canvasId: canvas.canvasId, nodeId },
      { transient: options?.transient },
    );
  const openedNode = canvas.nodes.find((node) => node.id === nodeId);
  if (tabId && openedNode?.type === 'note') {
    usePreviewWorkspaceStore.getState().requestNodeFocus(tabId);
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
export async function openNewChat(
  groupId?: string,
  settleTab?: (tabId: string) => void,
): Promise<string> {
  const initial = usePreviewWorkspaceStore.getState();
  const canvasId = initial.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';
  try {
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
    const threadId = useChatStore.getState().createThread({ binding });
    if (group.activeTabId) settleTab?.(group.activeTabId);
    usePanelStore.getState().requestOpenRightPanel();
    const tabId = preview.openPreviewTarget(
      { kind: 'chat', canvasId, threadId },
      { groupId: group.id },
    );
    usePanelStore.getState().requestFocusChatInput(threadId);
    return tabId;
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
      ? findTabByTarget(preview.workspace, {
          kind: 'chat',
          canvasId,
          threadId: sourceThreadId,
        })
      : null;
  const groupId = source
    ? groupOfTab(preview.workspace, source.id)?.id
    : undefined;
  if (source) {
    if (source.target.kind === 'node') {
      settleNodePreprocess(source.target.nodeId);
    }
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

  const node = useCanvasStore
    .getState()
    .nodes.find((candidate) => candidate.id === target.nodeId);
  preview.closeTab(activeTab.id, () => {
    if (node?.type === 'note' || node?.type === 'text') {
      settleNodePreprocess(node.id);
    }
  });
}
