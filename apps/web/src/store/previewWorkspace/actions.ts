// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

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
export function openChat(): string {
  const preview = usePreviewWorkspaceStore.getState();
  const canvasId = preview.canvasId || useCanvasStore.getState().canvasId;
  if (!canvasId) return '';

  const recentChat = Object.values(preview.workspace.tabs)
    .filter(
      (tab) => tab.target.kind === 'chat' && tab.target.canvasId === canvasId,
    )
    .sort((a, b) => b.lastActiveSeq - a.lastActiveSeq)[0];
  const threadId =
    recentChat?.target.kind === 'chat'
      ? recentChat.target.threadId
      : useChatStore.getState().createThread();

  usePanelStore.getState().requestOpenRightPanel();
  const tabId = preview.openPreviewTarget({ kind: 'chat', canvasId, threadId });
  usePanelStore.getState().requestFocusChatInput(threadId);
  return tabId;
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
