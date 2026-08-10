// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import useCanvasStore, {
  getProtectedPreviewTabIds,
  settleNodePreprocess,
} from '../canvasStore';
import { usePanelStore } from '../panelStore';
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
      getProtectedPreviewTabIds(),
    );
  useCanvasStore.setState((state) => ({
    expandedNodeFocusTick: state.expandedNodeFocusTick + 1,
  }));
  return tabId;
}

export function closeActivePreviewNode(): void {
  const workspace = usePreviewWorkspaceStore.getState();
  const activeTab = selectActiveTab(workspace);
  if (!activeTab) return;
  const target = activeTab?.target;
  if (target?.kind !== 'node') return;

  const node = useCanvasStore
    .getState()
    .nodes.find((candidate) => candidate.id === target.nodeId);
  if (node?.type === 'note' || node?.type === 'text') {
    settleNodePreprocess(node.id);
  }
  workspace.closeTab(activeTab.id);
}
