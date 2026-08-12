// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import type { CanvasPreviewWorkspace } from './model';

export function collectProtectedPreviewTabIds(
  workspace: CanvasPreviewWorkspace,
  context: {
    pendingNodeIds: ReadonlySet<string>;
    threadIdForNode: (nodeId: string) => string | undefined;
    isThreadStreaming: (threadId: string) => boolean;
  },
): Set<string> {
  const protectedTabIds = new Set<string>();

  for (const tab of Object.values(workspace.tabs)) {
    if (tab.target.kind === 'node') {
      if (context.pendingNodeIds.has(tab.target.nodeId)) {
        protectedTabIds.add(tab.id);
      }
      const threadId = context.threadIdForNode(tab.target.nodeId);
      if (threadId && context.isThreadStreaming(threadId)) {
        protectedTabIds.add(tab.id);
      }
    } else if (context.isThreadStreaming(tab.target.threadId)) {
      protectedTabIds.add(tab.id);
    }
  }

  return protectedTabIds;
}
