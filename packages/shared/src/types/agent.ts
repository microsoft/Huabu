import type { ChatAttachment } from './chat.js';
import type { AgentBaseContext } from './context.js';
import type { IntentCandidate } from './intent.js';

/**
 * Unified Agent Types
 *
 * Types for the pi-ai powered unified agent that handles
 * ask and operate (canvas manipulation) modes.
 */

// ==================== Agent Modes ====================

export type AgentMode = 'ask' | 'operate';

// ==================== Request ====================

export interface AgentRequest {
  /** User message text */
  content: string;
  /** Thread ID for conversation persistence */
  threadId?: string;
  /** Agent mode */
  mode?: AgentMode;
  /** Canvas context for tool access and knowledge retrieval */
  canvasContext?: AgentBaseContext;
  /** Canvas ID (required for operate mode) */
  canvasId?: string;
  /** Image/file attachments */
  attachments?: ChatAttachment[];
  /** IDs of canvas nodes selected when the message was sent */
  selectedNodeIds?: string[];
  /** Intent-select data for operate mode triggered by intent recognition */
  intentData?: {
    candidates: IntentCandidate[];
    selectedIntent: string;
  };
}

// ==================== Streaming Events ====================

export type AgentStreamEventType =
  | 'meta'
  | 'text_delta'
  | 'tool_start'
  | 'tool_result'
  | 'thinking_delta'
  | 'done'
  | 'error'
  | 'end';

export interface AgentStreamEvent {
  type: AgentStreamEventType;
  data: {
    /** Thread ID and mode (for meta event) */
    threadId?: string;
    mode?: AgentMode;
    /** Incremental text content */
    content?: string;
    /** Tool name */
    toolName?: string;
    /** Tool call arguments */
    toolArgs?: Record<string, unknown>;
    /** Tool execution result */
    toolResult?: string;
    /** Final message text */
    message?: string;
    /** Error message */
    error?: string;
    /** Extra metadata */
    meta?: Record<string, unknown>;
  };
}

// ==================== History ====================

export interface AgentHistoryItem {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolName?: string;
  toolResult?: string;
}

export interface AgentHistoryResponse {
  threadId: string;
  messages: AgentHistoryItem[];
}
