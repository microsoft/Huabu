// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { create } from 'zustand';

import useCanvasStore from './canvasStore';
import { useWorkspaceStore } from './workspaceStore';

import type { PreviewTarget } from './previewWorkspace/model';
import type { RecentCanvasConversationResponse } from '@huabu/shared';

export type CommentDestination = NonNullable<
  RecentCanvasConversationResponse['conversation']
>;
type StagedDestination =
  | { kind: 'agent'; destination: CommentDestination }
  | { kind: 'temporary'; threadId: string };

function emptyMemory() {
  return {
    scope: {},
    lastComment: null as StagedDestination | null,
    lastPreview: null as CommentDestination | null,
    previewSequence: 0,
    previewOrder: new Map<string, number>(),
  };
}

/** Visit-local user intent, separate from persisted layout and server activity. */
export const useCommentDestinationMemory = create(emptyMemory);

export function commentDestinationKey(destination: CommentDestination) {
  return `${destination.nodeId}\0${destination.threadId}`;
}

export function isCommentScopeCurrent(canvasId: string, scope: object) {
  const canvas = useCanvasStore.getState();
  return (
    scope === useCommentDestinationMemory.getState().scope &&
    canvas.canvasId === canvasId &&
    !canvas.isLoading &&
    !useWorkspaceStore.getState().isSyncing
  );
}

export function rememberCommentDestination(
  canvasId: string,
  scope: object,
  destination: CommentDestination | null,
  threadId: string,
) {
  if (!isCommentScopeCurrent(canvasId, scope)) return;
  useCommentDestinationMemory.setState({
    lastComment: destination
      ? { kind: 'agent', destination }
      : { kind: 'temporary', threadId },
  });
}

/** Call only at user navigation/interaction boundaries, never on tab restore. */
export function rememberPreviewedAgent(target: PreviewTarget) {
  const canvas = useCanvasStore.getState();
  if (
    target.canvasId !== canvas.canvasId ||
    canvas.isLoading ||
    useWorkspaceStore.getState().isSyncing ||
    (target.kind !== 'node' && target.kind !== 'conversation')
  )
    return;
  const node = canvas.nodes.find((item) => item.id === target.nodeId);
  if (
    node?.type !== 'question' ||
    typeof node.data.threadId !== 'string' ||
    !node.data.threadId ||
    (target.kind === 'conversation' && target.threadId !== node.data.threadId)
  )
    return;
  const destination = { nodeId: node.id, threadId: node.data.threadId };
  useCommentDestinationMemory.setState((memory) => {
    if (
      memory.lastPreview?.nodeId === destination.nodeId &&
      memory.lastPreview.threadId === destination.threadId
    )
      return memory;
    const sequence = memory.previewSequence + 1;
    return {
      lastPreview: destination,
      previewSequence: sequence,
      previewOrder: new Map(memory.previewOrder).set(
        commentDestinationKey(destination),
        sequence,
      ),
    };
  });
}

useCanvasStore.subscribe((next, previous) => {
  if (
    next.canvasId !== previous.canvasId ||
    (next.isLoading && !previous.isLoading)
  )
    useCommentDestinationMemory.setState(emptyMemory(), true);
});

useWorkspaceStore.subscribe((next, previous) => {
  if (
    next.workspaceId !== previous.workspaceId ||
    next.workspacePath !== previous.workspacePath
  )
    useCommentDestinationMemory.setState(emptyMemory(), true);
});
