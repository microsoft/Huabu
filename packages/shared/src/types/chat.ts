export interface SendMessageRequest {
  content: string;
  /**
   * Conversation/thread identifier used to persist and resume LangGraph state.
   * Clients should generate a stable ID per chat session and reuse it.
   */
  threadId: string;
  /**
   * Source IDs from the selected canvas nodes.
   * Empty array means no sources selected.
   */
  selectedSourceIds: string[];
}

export type SendMessageResponse =
  | {
      messageId: string;
      reply: string;
    }
  | {
      error: string;
    };

// --- Streaming Types ---
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ChatMessageDTO {
  role: ChatRole;
  content: string;
  toolCalls?: {
    name: string;
    args: unknown;
    id: string;
  }[];
}

export interface ChatStreamUpdatePayload {
  node: string;
  // Normalized message content for chat rendering.
  message?: ChatMessageDTO;
  /**
   * Structured tool output (preferred for UI). When present, clients should
   * render tool results from this object rather than JSON-parsing message.content.
   */
  toolResponse?: ToolResponse<string, unknown>;
  // Extra payload details when needed.
  metadata?: Record<string, unknown>;
}

export interface ChatStreamEvent {
  event: 'update' | 'end' | 'error';
  data: ChatStreamUpdatePayload | Record<string, never> | { message: string };
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
