// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasPreviewWorkspace } from '@/store/previewWorkspace/model';

const GROUP_DROP_PREFIX = 'preview-group-drop:';

export const groupDropId = (groupId: string) =>
  `${GROUP_DROP_PREFIX}${groupId}`;

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
