// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { getQuestionNodeStatus } from '@huabu/shared';

import useCanvasStore from '@/store/canvasStore';
import { selectThreadMessages, useChatStore } from '@/store/chatStore';
import { findPendingPermissionRequestId } from '@/store/chatTypes';
import { conversationAttention, type AttentionKind } from '@/utils/attention';

/**
 * What a conversation holds that the person has not seen, found by its
 * Question node or by its thread. Null for anything that is no conversation.
 */
export function useConversationAttention(target: {
  nodeId?: string;
  threadId?: string;
}): AttentionKind | null {
  const { nodeId, threadId } = target;
  const data = useCanvasStore((state) =>
    nodeId || threadId
      ? state.nodes.find(
          (node) =>
            node.data.type === 'question' &&
            (nodeId ? node.id === nodeId : node.data.threadId === threadId),
        )?.data
      : undefined,
  );
  const thread =
    threadId ?? (typeof data?.threadId === 'string' ? data.threadId : null);
  const needsApproval = useChatStore(
    (state) =>
      thread !== null &&
      findPendingPermissionRequestId(selectThreadMessages(state, thread)) !==
        null,
  );
  return conversationAttention(
    getQuestionNodeStatus(data),
    data?.viewed === true,
    needsApproval,
  );
}
