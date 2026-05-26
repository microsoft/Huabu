/**
 * Translate ACP `session/update` notifications into Sediment's internal
 * `AgentStreamEvent` shape so existing SSE consumers don't need to know about
 * the ACP wire format.
 *
 * Current scope: only text content. Tool calls, plans, mode updates, and
 * non-text content blocks are ignored (returns null) and logged upstream.
 * Extend this to tool_start / tool_result / thinking_delta as needed.
 */

import type { AgentStreamEvent } from '@sediment/shared';

/** Subset of ACP ContentBlock that we currently recognise. */
interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

interface AcpContentBlockBase {
  type: string;
}

type AcpContentBlock = AcpTextContentBlock | AcpContentBlockBase;

/**
 * Subset of ACP `SessionUpdate` shape used by the translator. ACP uses the
 * `sessionUpdate` discriminator field (camelCase, snake_case values). Full
 * variant list is in the spec at agentclientprotocol.com/protocol/schema.
 */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: AcpContentBlock;
  // Other variant-specific fields exist (toolCallId, plan, ...) but we
  // don't currently care about them.
  [key: string]: unknown;
}

function isTextBlock(
  block: AcpContentBlock | undefined,
): block is AcpTextContentBlock {
  return (
    !!block &&
    block.type === 'text' &&
    typeof (block as AcpTextContentBlock).text === 'string'
  );
}

/**
 * Map one ACP session/update notification to a Sediment `AgentStreamEvent`.
 * Returns null for updates we don't yet translate — caller should log + drop.
 */
export function acpUpdateToStreamEvent(
  update: AcpSessionUpdate,
): AgentStreamEvent | null {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (!isTextBlock(update.content)) return null;
      return {
        type: 'text_delta',
        data: { content: update.content.text },
      };
    }
    // Future updates to map: agent_thought_chunk → thinking_delta,
    // tool_call → tool_start, tool_call_update → tool_result, etc.
    default:
      return null;
  }
}
