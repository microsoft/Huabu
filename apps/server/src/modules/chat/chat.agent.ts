/**
 * Chat Agent Implementation
 *
 * Implements the ChatAgent using the BaseAgent abstraction.
 * Handles event mapping from LangGraph to unified AgentEvent format.
 */

import {
  BaseAgent,
  type AgentConfig,
  type AgentEvent,
  type BaseAgentState,
} from '../agent/base/index.js';
import { createGraph } from '../agent/graph.js';
import { getCheckpointer } from '../agent/store/index.js';

// ==================== State ====================

/**
 * Chat Agent State
 */
export interface ChatAgentState extends BaseAgentState {
  /** Per-turn selection context (ephemeral, not persisted to history) */
  selectionContext?: string | null;

  /** User question for the current turn */
  question?: string;
}

// ==================== Agent ====================

export class ChatAgent extends BaseAgent<ChatAgentState> {
  readonly config: AgentConfig = {
    type: 'chat',
    name: 'Chat Assistant',
  };

  readonly graph: ReturnType<typeof createGraph>;

  private constructor(graph: ReturnType<typeof createGraph>) {
    super();
    this.graph = graph;
  }

  /**
   * Factory method: Create agent instance
   */
  static async create(): Promise<ChatAgent> {
    const checkpointer = await getCheckpointer();
    const graph = createGraph({ checkpointer });
    return new ChatAgent(graph);
  }

  /**
   * Event mapping logic (migrated from chat.route.ts)
   */
  protected mapToAgentEvent(
    chunk: unknown,
    _threadId: string,
  ): AgentEvent | null {
    if (!Array.isArray(chunk) || chunk.length < 2) return null;

    const mode = chunk[0];
    const payload = chunk[1];

    // Handle message stream
    if (mode === 'messages') {
      if (!Array.isArray(payload) || payload.length !== 2) return null;

      const [message, metadata] = payload as [unknown, Record<string, unknown>];
      const nodeName =
        typeof metadata.langgraph_node === 'string'
          ? metadata.langgraph_node
          : 'agent';

      // Only stream token-level deltas for the LLM node
      if (nodeName !== 'agent') return null;

      const role = this.getMessageRole(message);
      if (role !== 'assistant') return null;

      const content = this.getMessageContent(message);

      return {
        type: 'update',
        timestamp: Date.now(),
        data: {
          node: nodeName,
          message: { role, content },
        },
      };
    }

    // Handle node updates
    if (mode === 'updates') {
      if (typeof payload !== 'object' || payload === null) return null;

      const updateObj = payload as Record<string, unknown>;
      const nodeName = Object.keys(updateObj)[0] ?? 'unknown';
      const nodeResult = updateObj[nodeName];

      // Skip 'agent' node in updates mode — already streamed via 'messages'
      if (nodeName === 'agent') return null;

      const messages = this.getMessages(nodeResult);
      if (!messages || messages.length === 0) return null;

      const lastMessage = messages[messages.length - 1];
      const role = this.getMessageRole(lastMessage);
      const content = this.getMessageContent(lastMessage);
      const toolResponse = this.parseToolResponse(lastMessage);

      return {
        type: 'update',
        timestamp: Date.now(),
        data: {
          node: nodeName,
          toolResponse: toolResponse ?? undefined,
          message: { role: role as 'user' | 'assistant' | 'tool', content },
        },
      };
    }

    return null;
  }
}
