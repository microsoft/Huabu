// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { useChatStore } from '@/store/chatStore';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store';

/**
 * The conversations of a Space that no Question node holds: its canvas chat
 * and the standalone chats open in its Preview Workspace.
 *
 * The chat store keeps threads across Space navigation, so a thread found
 * there is not by that alone this Space's. A Question node names its own
 * thread; these are the only others a Space owns.
 */
export function standaloneThreadsOf(canvasId: string): Set<string> {
  const owned = new Set<string>();
  const canvasThread = useChatStore.getState().threadMap[canvasId];
  if (canvasThread) owned.add(canvasThread);
  const preview = usePreviewWorkspaceStore.getState();
  if (preview.canvasId === canvasId)
    for (const tab of Object.values(preview.workspace.tabs)) {
      const { target } = tab;
      if (
        (target.kind === 'chat' || target.kind === 'conversation') &&
        target.canvasId === canvasId
      )
        owned.add(target.threadId);
    }
  return owned;
}
