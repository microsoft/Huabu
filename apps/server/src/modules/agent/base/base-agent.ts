/**
 * Base Agent Implementation
 *
 * Provides a default implementation of the IAgent interface to reduce boilerplate
 * in concrete agents. Subclasses only need to implement agent-specific logic.
 */

import type { IAgent } from './agent.interface.js';
import type { AgentConfig, AgentEvent, BaseAgentState } from './agent.types.js';
import type { CompiledStateGraph } from '@langchain/langgraph';
import type { ToolResponse } from '@sediment/shared';

/**
 * Abstract base class for all agents.
 * Provides default stream() and getHistory() implementations, plus shared
 * LangChain message utility methods available to all subclasses.
 *
 * @template TState - The agent state type
 */
export abstract class BaseAgent<TState extends BaseAgentState = BaseAgentState>
  implements IAgent<TState>
{
  // ==================== Abstract (subclass must implement) ====================

  /**
   * Agent configuration metadata.
   */
  abstract readonly config: AgentConfig;

  /**
   * Compiled LangGraph instance.
   */
  abstract readonly graph: CompiledStateGraph<any, any, any>;

  // ==================== Abstract methods ====================

  /**
   * Map a raw LangGraph stream chunk to a unified AgentEvent.
   * Each subclass implements the mapping according to its own event semantics.
   *
   * @param chunk - Raw chunk yielded by the LangGraph stream
   * @param threadId - Active thread ID
   * @returns Mapped event, or null if the chunk should be skipped
   */
  protected abstract mapToAgentEvent(
    chunk: unknown,
    threadId: string,
  ): AgentEvent | null;

  // ==================== Core implementation ====================

  /**
   * Stream agent execution.
   * Default implementation uses both 'messages' and 'updates' stream modes:
   * - messages mode: token-level deltas from LLM nodes
   * - updates mode: complete message outputs from non-LLM nodes
   */
  async *stream(
    input: any,
    threadId: string,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const stream = await this.graph.stream(input, {
      streamMode: ['messages', 'updates'],
      configurable: { thread_id: threadId },
    });

    for await (const chunk of stream) {
      const event = this.mapToAgentEvent(chunk, threadId);
      if (event) {
        yield event;
      }
    }
  }

  /**
   * Restore persisted state from checkpoint.
   * Default implementation calls graph.getState().
   */
  async getHistory(threadId: string): Promise<TState | null> {
    try {
      const state = await this.graph.getState({
        configurable: { thread_id: threadId },
      });

      return (state?.values as TState) ?? null;
    } catch {
      return null;
    }
  }

  // ==================== Shared message utilities ====================
  // These helpers normalise raw LangChain message objects so subclasses
  // can implement mapToAgentEvent without duplicating parsing logic.

  /**
   * Extract the messages array from a graph node result object.
   * Returns null when the value is not an object with a `messages` property.
   */
  protected getMessages(value: unknown): unknown[] | null {
    if (typeof value !== 'object' || value === null) return null;
    const msgs = (value as { messages?: unknown }).messages;
    return Array.isArray(msgs) ? msgs : null;
  }

  /**
   * Determine the semantic role of a LangChain message object.
   */
  protected getMessageRole(message: unknown): string {
    if (typeof message !== 'object' || message === null) return 'assistant';
    const msg = message as {
      _getType?: () => string;
      constructor?: { name?: string };
    };
    const type = msg._getType?.();
    const ctor = msg.constructor?.name;
    if (type === 'system' || ctor === 'SystemMessage') return 'system';
    if (type === 'tool' || ctor === 'ToolMessage') return 'tool';
    if (type === 'human' || ctor === 'HumanMessage') return 'user';
    return 'assistant';
  }

  /**
   * Extract the text content from a LangChain message object.
   */
  protected getMessageContent(message: unknown): string {
    if (typeof message !== 'object' || message === null)
      return typeof message === 'string' ? message : '';
    const content = (message as { content?: unknown }).content;
    return typeof content === 'string'
      ? content
      : JSON.stringify(content ?? '');
  }

  /**
   * Extract a structured ToolResponse from a message's additional_kwargs.
   * Nodes that embed a ToolResponse object in additional_kwargs allow the
   * frontend to render all agent steps uniformly via the ToolMessage component.
   *
   * Falls back to JSON-parsing the content string for legacy tool messages.
   */
  protected parseToolResponse(
    message: unknown,
  ): ToolResponse<string, unknown> | null {
    if (typeof message !== 'object' || message === null) return null;
    const kwargs = (message as { additional_kwargs?: Record<string, unknown> })
      .additional_kwargs;
    if (kwargs?.toolResponse)
      return kwargs.toolResponse as ToolResponse<string, unknown>;
    // Fallback: try to parse content as JSON (legacy tool messages)
    const content = this.getMessageContent(message);
    try {
      return JSON.parse(content) as ToolResponse<string, unknown>;
    } catch {
      return null;
    }
  }
}
