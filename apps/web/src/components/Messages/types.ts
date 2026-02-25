import type { ToolResponse, ResearchStep } from '@sediment/shared';

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
    }
  | {
      id: string;
      role: 'research';
      query: string;
      steps: ResearchStep[];
      status: 'running' | 'completed' | 'error';
      nodeIds?: string[];
    };
