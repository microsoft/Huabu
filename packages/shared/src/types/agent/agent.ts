/**
 * Unified Agent Types
 *
 * Types for the pi-ai powered unified agent that handles
 * ask and operate (canvas manipulation) modes.
 */

// ==================== Agent Modes ====================

export type AgentMode = 'ask' | 'operate';

// ==================== Streaming Events ====================
//
// SSE events emitted by the unified `/api/agent` endpoint, modelled as a
// discriminated union so both server (`yield`) and client (`switch`)
// receive narrow, exact payloads per event type.

/** `event: meta` — sent once at the start of every stream. */
export interface AgentMetaEventData {
  threadId: string;
  mode: AgentMode;
}

/** `event: text_delta` — incremental assistant text. */
export interface AgentTextDeltaEventData {
  content: string;
}

/** `event: thinking_delta` — incremental "thinking" / reasoning text. */
export interface AgentThinkingDeltaEventData {
  content: string;
}

/** `event: tool_start` — model decided to call a tool. */
export interface AgentToolStartEventData {
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/** `event: tool_result` — server finished executing the tool. */
export interface AgentToolResultEventData {
  toolName: string;
  /** Raw tool result payload (usually a JSON-stringified value). */
  toolResult: string;
}

/** `event: done` — final assistant message + run-level metadata. */
export interface AgentDoneEventData {
  message: string;
  meta?: {
    stopReason?: string;
    usage?: unknown;
    iterations?: number;
  };
}

/** `event: error` — server-side error during streaming or tool execution. */
export interface AgentErrorEventData {
  error: string;
}

/** `event: end` — sentinel terminator (always last). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AgentEndEventData {}

/** Discriminated union of every SSE frame emitted by `/api/agent`. */
export type AgentStreamEvent =
  | { type: 'meta'; data: AgentMetaEventData }
  | { type: 'text_delta'; data: AgentTextDeltaEventData }
  | { type: 'thinking_delta'; data: AgentThinkingDeltaEventData }
  | { type: 'tool_start'; data: AgentToolStartEventData }
  | { type: 'tool_result'; data: AgentToolResultEventData }
  | { type: 'done'; data: AgentDoneEventData }
  | { type: 'error'; data: AgentErrorEventData }
  | { type: 'end'; data: AgentEndEventData };

export type AgentStreamEventType = AgentStreamEvent['type'];

/**
 * Canonical event-name constants. Use these instead of string literals
 * so a typo or rename causes a compile-time error.
 */
export const AGENT_SSE_EVENTS = {
  Meta: 'meta',
  TextDelta: 'text_delta',
  ThinkingDelta: 'thinking_delta',
  ToolStart: 'tool_start',
  ToolResult: 'tool_result',
  Done: 'done',
  Error: 'error',
  End: 'end',
} as const satisfies Record<string, AgentStreamEventType>;
