/**
 * Shared orchestration for entering a question node's chat conversation.
 *
 * Question nodes are born bound to a chat thread. Every entry point that
 * "enters" that conversation (toolbar placement, connected-node picker,
 * double-click compose) needs the same steps: mint the thread, open the
 * chat panel in compose mode, and focus the input. Keeping it in one place
 * ensures those steps stay in sync across callers.
 */
import { createId } from '@sediment/shared';

import { useChatStore } from '@/store/chatStore.ts';
import { usePanelStore } from '@/store/panelStore.ts';

import type { AddNodeInput } from '@/handler/canvasCommand/uiIntent.ts';
import type { CanvasNodeId } from '@sediment/shared';

/**
 * Open the chat panel in compose mode for a question node's thread and
 * focus the input.
 */
export function enterQuestionCompose(
  nodeId: string,
  threadId: string,
  canvasId: string | null,
): void {
  useChatStore
    .getState()
    .openQuestionCompose(nodeId, threadId, canvasId || undefined);
  usePanelStore.getState().requestOpenRightPanel();
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
  enterQuestionCompose(nodeId, threadId, opts.canvasId);
  return { nodeId, threadId };
}
