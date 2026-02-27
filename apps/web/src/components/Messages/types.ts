import type { ToolResponse } from '@sediment/shared';

export type ChatMessage =
  | {
      id: string;
      role: 'user' | 'assistant';
      content: string;
    }
  | {
      id: string;
      role: 'tool';
      toolResponse: ToolResponse<string, unknown>;
    };
