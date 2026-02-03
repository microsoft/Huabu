export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
  reply: string;
}

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
  // Instead of raw raw state, we send a normalized message
  message?: ChatMessageDTO;
  // Or raw tool outputs if needed
  metadata?: Record<string, unknown>;
}

export interface ChatStreamEvent {
  event: 'update' | 'end' | 'error';
  data: ChatStreamUpdatePayload | Record<string, never> | { message: string };
}
