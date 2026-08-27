// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Shared orchestration for entering a question node's chat conversation.
 *
 * Question nodes are born bound to a chat thread. Every entry point that
 * "enters" that conversation (toolbar placement, connected-node picker,
 * double-click compose) needs the same steps: mint the thread, open the
 * chat panel in compose mode, and focus the input. Keeping it in one place
 * ensures those steps stay in sync across callers.
 */
import { createId } from '@huabu/shared';

import useCanvasStore from '@/store/canvasStore.ts';
import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';
import { openPreviewNode } from '@/store/previewWorkspace/actions.ts';
import { usePreviewWorkspaceStore } from '@/store/previewWorkspace/store.ts';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent.ts';
import type {
  AgentBinding,
  AgentConversationView,
  CanvasNodeId,
} from '@huabu/shared';

function initializeQuestionBinding(
  view: AgentConversationView,
  binding: AgentBinding | undefined,
  canvasId: string | null,
  inheritCanvasDefault: boolean,
): void {
  const chat = useChatStore.getState();
  const ownerCanvasId = canvasId ?? view.conversationOwner.canvasId;
  const effectiveBinding =
    binding ??
    (inheritCanvasDefault ? chat.bindingMap[ownerCanvasId] : undefined);
  if (effectiveBinding) {
    chat.setAgentBinding(view.conversationOwner.threadId, effectiveBinding);
  }
}

/** Open an authored Question conversation in the active presentation mode. */
export function enterQuestionConversation(
  view: AgentConversationView,
  binding: AgentBinding | undefined,
  canvasId: string | null,
  openPosition: 'last-user' | 'bottom',
  options?: { transient?: boolean },
): void {
  useChatStore
    .getState()
    .makeThreadMetadataEphemeral(view.conversationOwner.threadId);
  initializeQuestionBinding(view, binding, canvasId, false);
  const tabId = openPreviewNode(view.presentationAnchor.nodeId, options);
  if (tabId) {
    usePreviewWorkspaceStore.getState().requestChatOpen(tabId, openPosition);
  }
}

/**
 * Open the chat panel in compose mode for a question node's thread and
 * focus the input.
 */
export function enterQuestionCompose(
  view: AgentConversationView,
  canvasId: string | null,
  binding?: AgentBinding,
  options?: { transient?: boolean },
): void {
  initializeQuestionBinding(view, binding, canvasId, true);
  openPreviewNode(view.presentationAnchor.nodeId, options);
  usePanelStore
    .getState()
    .requestFocusChatInput(view.conversationOwner.threadId);
}

/**
 * Create a question node bound to a fresh thread at `placementPoint` and
 * immediately enter compose. The node id and thread id are minted up front
 * so callers can wire follow-up work (e.g. a connecting edge) to the new
 * node. Pass `id` to reuse a pre-minted node id.
 */
export function createQuestionNodeAndCompose(opts: {
  addNode: (input: AddNodeInput) => void;
  placementPoint: { x: number; y: number };
  canvasId: string | null;
  id?: CanvasNodeId;
}): { nodeId: CanvasNodeId; threadId: string } {
  const nodeId = opts.id ?? (createId('node') as CanvasNodeId);
  const threadId = createId('thread');
  const canvasId = opts.canvasId ?? useCanvasStore.getState().canvasId;
  opts.addNode({
    id: nodeId,
    nodeType: 'question',
    placementPoint: opts.placementPoint,
    data: {
      content: '',
      threadId,
      origin: { type: 'user-created' },
    },
  });
  enterQuestionCompose(
    {
      presentationAnchor: {
        canvasId,
        nodeId,
      },
      conversationOwner: {
        canvasId,
        nodeId,
        threadId,
      },
    },
    opts.canvasId,
  );
  return { nodeId, threadId };
}
