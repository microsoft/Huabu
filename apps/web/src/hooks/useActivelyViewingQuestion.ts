// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "Actively viewing" a question's conversation requires:
 *   1. a Preview Workspace tab presents its node, and
 *   2. that panel is expanded (not collapsed), and
 *   3. its desktop Space Tab is active (when running in desktop Tabs).
 *
 * A collapsed panel means the user is not actually watching, so a completing
 * run must stay unread and the on-canvas badge must fall back to the node's
 * real status. This rule was previously re-derived inline in several places
 * (badge render, viewed-marking on stream completion) and a couple of them
 * forgot the "panel expanded" half, which caused the badge to stick on `open`
 * and completed answers to be silently marked read. Centralising it here keeps
 * every call site consistent.
 */

import useCanvasStore from '@/store/canvasStore';
import { useDesktopTabStore } from '@/store/desktopTabStore';
import { usePanelStore } from '@/store/panelStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

import { getElectronBridge } from './useElectron';

import type {
  CanvasPreviewWorkspace,
  PreviewTab,
} from '@/store/previewWorkspace/model';

function activeTabs(workspace: CanvasPreviewWorkspace): PreviewTab[] {
  return workspace.groups.flatMap((group) => {
    const tab = group.activeTabId
      ? workspace.tabs[group.activeTabId]
      : undefined;
    return tab ? [tab] : [];
  });
}

/** Reactive form — use inside render logic. */
export function useActivelyViewingQuestionNode(nodeId: string): boolean {
  const anchored = usePreviewWorkspaceStore((state) =>
    activeTabs(state.workspace).some(
      (tab) => tab.target.kind === 'node' && tab.target.nodeId === nodeId,
    ),
  );
  const panelExpanded = usePanelStore((s) => !s.isRightCollapsed);
  const desktopActive = useDesktopTabStore((state) => state.isActive);
  return (
    anchored &&
    panelExpanded &&
    (getElectronBridge()?.tabs?.context.role !== 'space' || desktopActive)
  );
}

/**
 * Imperative snapshot — use inside non-reactive callbacks (e.g. stream
 * completion handlers). Matches on either the node id or the thread id,
 * whichever the caller has on hand.
 */
export function isActivelyViewingQuestion(match: {
  nodeId?: string;
  threadId?: string;
}): boolean {
  if (
    getElectronBridge()?.tabs?.context.role === 'space' &&
    !useDesktopTabStore.getState().isActive
  )
    return false;
  const workspace = usePreviewWorkspaceStore.getState().workspace;
  const canvas = useCanvasStore.getState();
  const matches = activeTabs(workspace).some((tab) => {
    if (tab.target.kind !== 'node') return false;
    const targetNodeId = tab.target.nodeId;
    if (match.nodeId === targetNodeId) return true;
    if (!match.threadId) return false;
    const node = canvas.nodes.find(
      (candidate) => candidate.id === targetNodeId,
    );
    return node?.type === 'question' && node.data.threadId === match.threadId;
  });
  return matches && !usePanelStore.getState().isRightCollapsed;
}
