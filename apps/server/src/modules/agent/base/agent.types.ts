/**
 * Agent Base Types (Simplified)
 *
 * Simplified type system based on the actual needs of the chat and research agents.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { ToolResponse } from '@sediment/shared';

// ==================== Agent Config ====================

/**
 * Agent type identifier.
 */
export type AgentType = 'chat' | 'research' | string;

/**
 * Agent configuration (simplified).
 */
export interface AgentConfig {
  /** Agent type identifier */
  type: AgentType;

  /** Human-readable agent name */
  name: string;
}

// ==================== Agent State ====================

/**
 * Base state shared by all agents.
 * Contains only the fields required by both chat and research agents.
 * Note: the thread/session ID is not stored in state — it is passed as a
 * parameter to stream() and getHistory() and mapped to LangGraph's thread_id.
 */
export interface BaseAgentState {
  /** Message history (standard LangGraph field) */
  messages: BaseMessage[];

  /** Accumulated errors */
  errors: string[];

  /** Unix timestamp when the session started */
  startTime: number;

  /** Unix timestamp when the session ended */
  endTime?: number;
}

// ==================== Agent Events ====================

/**
 * Unified event type shared by chat and research agents.
 * All intermediate state is carried via data.toolResponse;
 * there are no agent-specific event types.
 */
export type AgentEventType = 'update' | 'complete' | 'error';

/**
 * Unified agent event emitted by the SSE stream.
 */
export interface AgentEvent {
  /** Event type */
  type: AgentEventType;

  /** Unix timestamp */
  timestamp: number;

  /** Event payload */
  data: {
    /** Name of the graph node that produced this event */
    node?: string;
    /** Text message (token delta for LLM nodes, summary for tool nodes) */
    message?: { role: string; content: string };
    /**
     * Structured tool output.
     * When present, the frontend should use this field to render the ToolMessage
     * instead of parsing message.content.
     */
    toolResponse?: ToolResponse<string, unknown>;
    /** Additional metadata (used by complete / error events) */
    meta?: Record<string, unknown>;
  };
}
