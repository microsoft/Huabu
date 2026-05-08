import type { IntentCandidate } from './intent.js';

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

// --- Tool Result Types ---
export type ToolName = string;

export type ToolResponse<TTool extends ToolName, TData> =
  | {
      tool: TTool;
      status: 'success';
      data: TData;
    }
  | {
      tool: TTool;
      status: 'error';
      /**
       * A user-facing, stable error message suitable for UI display.
       * Keep it short and actionable (do not include sensitive data).
       */
      error: string;
      /**
       * Optional suggestion for how to fix the issue (e.g., missing env var).
       */
      hint?: string;
    };

export interface WebSearchResultItem {
  title: string;
  url: string;
  content?: string;
  /**
   * Optional reference to externally stored content when the full payload is
   * too large to embed in tool messages/checkpoints.
   */
  contentRef?: string;
  favicon?: string;
  score?: number;
}

export interface WebSearchToolData {
  query: string;
  answer?: string;
  results: WebSearchResultItem[];
}

export type WebSearchToolResponse = ToolResponse<
  'web_search',
  WebSearchToolData
>;

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
