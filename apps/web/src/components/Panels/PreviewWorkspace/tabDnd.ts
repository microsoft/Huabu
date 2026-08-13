// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasPreviewWorkspace } from '@/store/previewWorkspace/model';

const GROUP_DROP_PREFIX = 'preview-group-drop:';

export const groupDropId = (groupId: string) =>
  `${GROUP_DROP_PREFIX}${groupId}`;

export type TabDropIndicator =
  | { type: 'tab'; tabId: string; edge: 'before' | 'after' }
  | { type: 'group-end'; groupId: string };

export function resolveTabDropIndicator(
  workspace: CanvasPreviewWorkspace,
  activeTabId: string | null,
  overId: string | null,
): TabDropIndicator | null {
  if (!activeTabId || !overId || activeTabId === overId) return null;

  const overGroup = workspace.groups.find((group) =>
    group.tabIds.includes(overId),
  );
  if (overGroup) {
    const activeGroup = workspace.groups.find((group) =>
      group.tabIds.includes(activeTabId),
    );
    const edge =
      activeGroup?.id === overGroup.id &&
      activeGroup.tabIds.indexOf(activeTabId) < overGroup.tabIds.indexOf(overId)
        ? 'after'
        : 'before';
    return { type: 'tab', tabId: overId, edge };
  }

  const appendGroup = workspace.groups.find(
    (group) => groupDropId(group.id) === overId,
  );
  return appendGroup ? { type: 'group-end', groupId: appendGroup.id } : null;
}

export function resolveTabDropDestination(
  workspace: CanvasPreviewWorkspace,
  activeTabId: string,
  overId: string,
): { groupId: string; index: number } | null {
  if (!workspace.tabs[activeTabId] || activeTabId === overId) return null;

  const overTabGroup = workspace.groups.find((group) =>
    group.tabIds.includes(overId),
  );
  if (overTabGroup) {
    return {
      groupId: overTabGroup.id,
      index: overTabGroup.tabIds.indexOf(overId),
    };
  }

  const overGroup = workspace.groups.find(
    (group) => groupDropId(group.id) === overId,
  );
  return overGroup
    ? { groupId: overGroup.id, index: overGroup.tabIds.length }
    : null;
}
