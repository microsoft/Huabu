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
  /**
   * Stable per-call identifier supplied by the LLM tool-call protocol.
   * Pairs a `tool_start` with its eventual `tool_result` even when
   * tools execute in parallel and complete out of declaration order.
   * Optional for backward compatibility with older server builds.
   */
  toolCallId?: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/** `event: tool_result` — server finished executing the tool. */
export interface AgentToolResultEventData {
  /**
   * Stable per-call identifier matching the `toolCallId` on the
   * corresponding `tool_start` event. Optional for backward
   * compatibility with older server builds.
   */
  toolCallId?: string;
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

/**
 * Structured rewrite of a raw user message for an external (ACP) agent.
 *
 * The preprocessor is an **intent translator**, not a file router. It
 * reads the user's raw input plus the canvas state and produces a
 * **self-contained briefing**: the external agent should be able to
 * act on `task` alone, with no visibility into the canvas. Selected
 * node content is synthesised inline whenever it fits.
 *
 * `attachments` is a **fallback channel** for verbatim payloads — used
 * only when (a) the task requires byte-exact reading (e.g. "review
 * this code"), (b) a node exceeds the inline-body threshold, or
 * (c) the user explicitly attached a `.artifacts/` file. The external
 * agent is expected to `Read` each attachment before answering.
 *
 * Paths are relative to the canvas directory on disk
 * (`<canvasDir>/nodes/<safeLabel>.md`, `<canvasDir>/.artifacts/…`).
 */
export interface ExternalAgentPrompt {
  /** Self-contained task description handed to the external agent. */
  task: string;
  /** Files the external agent MUST read verbatim before acting. */
  attachments: Array<{
    /** Path relative to the canvas directory. */
    path: string;
    /** Why verbatim reading is required (≤ ~80 chars). */
    reason: string;
  }>;
}

/**
 * `event: prepared_prompt` — emitted once per external-agent turn,
 * before the first `text_delta`, when Huabu's preprocessor has
 * rewritten the user's raw message into a structured
 * {@link ExternalAgentPrompt}. Internal-agent turns never emit this.
 *
 * When the preprocessor fails the server still emits this event with
 * `prompt: null` + an `error` description so the UI can replace its
 * pending "Preparing…" placeholder with a concrete failure note
 * (and Huabu falls back to forwarding the raw user message).
 */
export interface AgentPreparedPromptEventData {
  /** Structured prompt produced by the preprocessor, or `null` on failure. */
  prompt: ExternalAgentPrompt | null;
  /** Short alias of the bound external agent (e.g. `'claude'`). */
  agentAlias: string;
  /** Reason the preprocessor failed; only set when `prompt === null`. */
  error?: string;
}

/** Discriminated union of every SSE frame emitted by `/api/agent`. */
export type AgentStreamEvent =
  | { type: 'meta'; data: AgentMetaEventData }
  | { type: 'text_delta'; data: AgentTextDeltaEventData }
  | { type: 'thinking_delta'; data: AgentThinkingDeltaEventData }
  | { type: 'tool_start'; data: AgentToolStartEventData }
  | { type: 'tool_result'; data: AgentToolResultEventData }
  | { type: 'prepared_prompt'; data: AgentPreparedPromptEventData }
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
  PreparedPrompt: 'prepared_prompt',
  Done: 'done',
  Error: 'error',
  End: 'end',
} as const satisfies Record<string, AgentStreamEventType>;
