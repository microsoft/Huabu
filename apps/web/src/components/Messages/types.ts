import type {
  ChatAttachment,
  IntentCandidate,
  ToolResponse,
} from '@sediment/shared';

/** A resource label created by an agent tool call (e.g. node, edge, frame). */
export interface ResourceLabel {
  type: 'node' | 'edge' | 'frame' | 'source';
  nodeType?: string;
  label: string;
  id?: string;
}

export type ChatMessage =
  | {
      id: string;
      role: 'user' | 'assistant';
      content: string;
      /** Image/file attachments included with this message. */
      attachments?: ChatAttachment[];
      /** Resources created during the agent's response. */
      resources?: ResourceLabel[];
    }
  | {
      id: string;
      role: 'tool';
      toolResponse: ToolResponse<string, unknown>;
      /** Whether this tool is currently executing (streaming). */
      isExecuting?: boolean;
    }
  | {
      id: string;
      role: 'intent-select';
      /** The intent candidates to choose from. */
      candidates: IntentCandidate[];
      /** Currently selected intent label. */
      selectedIntent: string;
      /** Custom intent text typed by user. */
      customIntent?: string;
    };
