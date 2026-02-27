/**
 * Research Agent Implementation
 *
 * Follows the same streaming pattern as ChatAgent:
 *   - messages mode  → stream LLM token deltas (synthesis node)
 *   - updates mode   → emit complete messages from all other nodes
 *
 * Each research graph node appends an AIMessage that carries structured
 * progress info in additional_kwargs.toolResponse, so the frontend can
 * render all agent steps uniformly via the existing ToolMessage component.
 */

import { getResearchGraph } from './graphs/research.graph.js';
import {
  BaseAgent,
  type AgentConfig,
  type AgentEvent,
  type BaseAgentState,
} from '../agent/base/index.js';

import type { ResearchConfig, SearchResult } from '@sediment/shared';

// ==================== State ====================

/**
 * Research Agent State.
 * Extends BaseAgentState with research-specific fields used for
 * inter-node communication inside the graph; only `messages` is
 * streamed to the outside world.
 */
export interface ResearchAgentState extends BaseAgentState {
  query: string;
  canvasId: string;
  threadId: string;
  canvasVersion: number;
  selectedSourceIds: string[];
  config: ResearchConfig;
  subQueries: string[];
  searchResults: SearchResult[];
  createdNodeIds: string[];
  synthesisNodeIds: string[];
  frameId: string | null;
  finalCanvasVersion: number | null;
}

// ==================== Agent ====================

export class ResearchAgent extends BaseAgent<ResearchAgentState> {
  readonly config: AgentConfig = {
    type: 'research',
    name: 'Deep Research',
  };

  readonly graph: Awaited<ReturnType<typeof getResearchGraph>>;

  private constructor(graph: Awaited<ReturnType<typeof getResearchGraph>>) {
    super();
    this.graph = graph;
  }

  static async create(): Promise<ResearchAgent> {
    const graph = await getResearchGraph();
    return new ResearchAgent(graph);
  }

  /**
   * Same streaming pattern as ChatAgent.
   *
   * messages mode → token deltas from the `synthesis` LLM node
   * updates mode  → complete AIMessages from every other node
   *                 (toolResponse carried in additional_kwargs)
   */
  protected mapToAgentEvent(
    chunk: unknown,
    _threadId: string,
  ): AgentEvent | null {
    if (!Array.isArray(chunk) || chunk.length < 2) return null;

    const [mode, payload] = chunk as [string, unknown];

    // ── messages mode: stream synthesis tokens ──
    if (mode === 'messages') {
      if (!Array.isArray(payload) || payload.length !== 2) return null;

      const [message, metadata] = payload as [unknown, Record<string, unknown>];
      const nodeName =
        typeof metadata.langgraph_node === 'string'
          ? metadata.langgraph_node
          : '';

      // Only stream the synthesis node — others emit via updates mode
      if (nodeName !== 'synthesis') return null;

      const role = this.getMessageRole(message);
      if (role !== 'assistant') return null;

      return {
        type: 'update',
        timestamp: Date.now(),
        data: {
          node: nodeName,
          message: { role, content: this.getMessageContent(message) },
        },
      };
    }

    // ── updates mode: complete messages from each node ──
    if (mode === 'updates') {
      if (typeof payload !== 'object' || payload === null) return null;

      const updateObj = payload as Record<string, unknown>;
      const nodeName = Object.keys(updateObj)[0] ?? 'unknown';

      // Skip synthesis in updates mode — its content is already streamed via messages mode
      if (nodeName === 'synthesis') return null;

      const messages = this.getMessages(updateObj[nodeName]);
      if (!messages || messages.length === 0) return null;

      const last = messages[messages.length - 1];
      const role = this.getMessageRole(last);
      const content = this.getMessageContent(last);

      return {
        type: 'update',
        timestamp: Date.now(),
        data: {
          node: nodeName,
          toolResponse: this.parseToolResponse(last) ?? undefined,
          message: { role, content },
        },
      };
    }

    return null;
  }
}
