import type { ChatAttachment, ToolResponse } from '@sediment/shared';

export type ChatMessage =
  | {
      id: string;
      role: 'user' | 'assistant';
      content: string;
      /** Image/file attachments included with this message. */
      attachments?: ChatAttachment[];
    }
  | {
      id: string;
      role: 'tool';
      toolResponse: ToolResponse<string, unknown>;
    };
