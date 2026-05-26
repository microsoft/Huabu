import type {
  ChatAttachment,
  ExternalAgentPrompt,
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
      /** IDs of canvas nodes selected when this message was sent. */
      selectedNodeIds?: string[];
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
      role: 'status';
      status: 'interrupted' | 'error';
      detail?: string;
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
    }
  | {
      id: string;
      role: 'prepared-prompt';
      /**
       * Structured prompt the ACP preprocessor produced for the
       * external agent. `null` while we're still waiting on the
       * preprocessor's LLM call (pending state) or when the call
       * failed outright (in which case `error` is set).
       */
      prompt: ExternalAgentPrompt | null;
      /** Short alias of the bound external agent (`'claude'`, etc.). */
      agentAlias: string;
      /** Preprocessor failure detail; presence indicates the fallback path ran. */
      error?: string;
    };
