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

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent.ts';
import type { AgentConversationView, CanvasNodeId } from '@huabu/shared';

/**
 * Open the chat panel in compose mode for a question node's thread and
 * focus the input.
 */
export function enterQuestionCompose(
  view: AgentConversationView,
  canvasId: string | null,
): void {
  useChatStore.getState().openQuestionCompose(view, canvasId || undefined);
  usePanelStore
    .getState()
    .requestOpenRightPanel(view.presentationAnchor.nodeId);
  usePanelStore.getState().requestFocusChatInput();
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
