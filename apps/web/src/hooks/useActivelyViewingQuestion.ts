// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * "Actively viewing" a question's conversation means BOTH:
 *   1. its thread is the one the chat panel is currently pointed at
 *      (`viewingQuestionThread`), and
 *   2. that panel is expanded (not collapsed).
 *
 * A collapsed panel means the user is not actually watching, so a completing
 * run must stay unread and the on-canvas badge must fall back to the node's
 * real status. This rule was previously re-derived inline in several places
 * (badge render, viewed-marking on stream completion) and a couple of them
 * forgot the "panel expanded" half, which caused the badge to stick on `open`
 * and completed answers to be silently marked read. Centralising it here keeps
 * every call site consistent.
 */

import { useChatStore } from '@/store/chatStore';
import { usePanelStore } from '@/store/panelStore';

/** Reactive form — use inside render logic. */
export function useActivelyViewingQuestionNode(nodeId: string): boolean {
  const anchored = useChatStore(
    (s) =>
      s.viewingQuestionThread?.presentationAnchor.nodeId === nodeId ||
      s.viewingQuestionThread?.conversationOwner.nodeId === nodeId,
  );
  const panelExpanded = usePanelStore((s) => !s.isRightCollapsed);
  return anchored && panelExpanded;
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
  const viewing = useChatStore.getState().viewingQuestionThread;
  if (!viewing) return false;
  const matches =
    (match.nodeId !== undefined &&
      (viewing.presentationAnchor.nodeId === match.nodeId ||
        viewing.conversationOwner.nodeId === match.nodeId)) ||
    (match.threadId !== undefined &&
      viewing.conversationOwner.threadId === match.threadId);
  return matches && !usePanelStore.getState().isRightCollapsed;
}
