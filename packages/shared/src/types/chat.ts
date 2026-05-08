import type { IntentCandidate } from './intent.js';
import type { ToolResponse } from './tools.js';

/**
 * An attachment sent alongside a chat message — e.g. a captured PDF region or pasted file.
 */
export interface ChatAttachment {
  type: 'image' | 'pdf' | 'text' | 'file' | 'web';
  source: 'upload' | 'excerpt' | 'selection';
  originNodeId?: string;
  url?: string;
  content?: string;
  label?: string;
  filename?: string;
}

// --- Chat History ---

/** A single message item returned by the history endpoint. */
export type ChatHistoryItem =
  | {
      role: 'user' | 'assistant';
      content: string;
      /** Image attachments recovered from multimodal messages. */
      attachments?: ChatAttachment[];
      /** IDs of canvas nodes that were selected when this message was sent. */
      selectedNodeIds?: string[];
    }
  | {
      role: 'tool';
      toolResponse: ToolResponse<string, unknown>;
    }
  | {
      role: 'status';
      status: 'interrupted' | 'error';
      /** Optional detail message for the status. */
      detail?: string;
    }
  | {
      role: 'intent-select';
      candidates: IntentCandidate[];
      selectedIntent: string;
    };

/** Response from GET /api/chat/history/:threadId */
export interface ChatHistoryResponse {
  threadId: string;
  messages: ChatHistoryItem[];
}
