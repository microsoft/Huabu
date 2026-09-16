// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type {
  CanvasPreviewWorkspace,
  PreviewGroup,
  PreviewTab,
} from '@/store/previewWorkspace/model';
import type { Node } from '@xyflow/react';

const RETAINABLE_NODE_TYPES = new Set([
  'note',
  'text',
  'pdf',
  'office',
  'question',
]);

export function canRetainPreviewNode(node: Node): boolean {
  return RETAINABLE_NODE_TYPES.has(node.type ?? '');
}

export function selectRetainedPreviewTabs(
  group: PreviewGroup,
  workspace: CanvasPreviewWorkspace,
  retainableTabIds: ReadonlySet<string>,
): PreviewTab[] {
  const activeTabId = group.activeTabId;
  if (!activeTabId) return [];

  let warmTab: PreviewTab | undefined;
  for (const tabId of group.tabIds) {
    if (tabId === activeTabId) continue;
    const tab = workspace.tabs[tabId];
    if (!tab || !retainableTabIds.has(tabId)) continue;
    if (!warmTab || tab.lastActiveSeq > warmTab.lastActiveSeq) warmTab = tab;
  }

  const retainedIds = new Set([activeTabId, warmTab?.id]);
  return group.tabIds.flatMap((tabId) => {
    const tab = workspace.tabs[tabId];
    return tab && retainedIds.has(tabId) ? [tab] : [];
  });
}
