/**
 * Agent Interface (Simplified)
 *
 * Defines the minimal contract that every agent must implement,
 * based on the actual requirements of the chat and research agents.
 */

import type { AgentConfig, AgentEvent, BaseAgentState } from './agent.types.js';
import type { CompiledStateGraph } from '@langchain/langgraph';

// ==================== Core Interface ====================

/**
 * Core agent interface.
 * All concrete agents must implement this interface.
 *
 * @template TState - The agent's state type (must extend BaseAgentState)
 */
export interface IAgent<TState extends BaseAgentState = BaseAgentState> {
  /**
   * Agent configuration metadata.
   */
  readonly config: AgentConfig;

  /**
   * Compiled LangGraph instance.
   */
  readonly graph: CompiledStateGraph<any, any, any>;

  /**
   * Execute the agent and stream events in real time.
   *
   * @param input - Agent-specific input payload
   * @param threadId - Thread identifier passed to LangGraph as thread_id
   * @returns Async generator of unified AgentEvents
   */
  stream(
    input: any,
    threadId: string,
  ): AsyncGenerator<AgentEvent, void, unknown>;

  /**
   * Restore the persisted state from a checkpoint.
   * Used to recover conversation / research state after a page refresh.
   *
   * @param threadId - Thread identifier passed to LangGraph as thread_id
   * @returns Restored state, or null if no checkpoint exists
   */
  getHistory(threadId: string): Promise<TState | null>;
}
