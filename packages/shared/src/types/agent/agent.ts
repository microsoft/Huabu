/**
 * Unified Agent Types
 *
 * Types for the pi-ai powered unified agent that handles
 * ask and operate (canvas manipulation) modes.
 */

import type {
  AcpCost,
  AcpPermissionOption,
  AcpPlanEntry,
  AcpSessionConfigOption,
  AcpSessionMode,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
} from './acp-tool.js';

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

/**
 * `event: tool_call` — agent declared a tool invocation.
 *
 * The unified wire shape for both internal (pi-ai) and external (ACP)
 * tool calls, following ACP §session/update: a stable `toolCallId`,
 * semantic `kind`, lifecycle `status`, list of source `locations`, and
 * rich `content` blocks (text/image/diff/terminal).
 *
 * Render-variant dispatch happens client-side via
 * {@link variantForInternalTool} keyed on `internalToolName`:
 * internal-agent turns set that field and materialise as their
 * dedicated variant (`canvas_commands`, `agent_tool`, …); external
 * ACP turns leave it undefined and always render as `generic`.
 */
export interface AgentToolCallEventData {
  toolCallId: string;
  /** Human-readable title from the agent (e.g. `Read app.ts`). */
  title: string;
  /**
   * Shell command behind the title, derived server-side from `rawInput`.
   * Present only for command-style tools; lets the UI show WHICH command
   * ran without recomputing client-side.
   */
  command?: string;
  /** ACP semantic kind; undefined when the agent does not classify. */
  toolKind?: AcpToolKind;
  /** Initial lifecycle status, usually `pending`. */
  status?: AcpToolCallStatus;
  /** Source-file locations the tool touched. */
  locations?: AcpToolCallLocation[];
  /** Content blocks (often empty at declaration time, filled by updates). */
  content?: AcpToolCallContent[];
  /** Raw arguments the agent attached (passed through unmodified). */
  rawInput?: unknown;
  /**
   * Stable tool name from the internal agent (`canvas_commands`,
   * `web_search`, `read`, `grep`, …). Drives client-side render-variant
   * dispatch via `variantForInternalTool()` and gates local side-effects
   * (e.g. `canvas_commands` execution).
   *
   * Undefined for external ACP turns, which carry only a display
   * `title` + semantic `toolKind`; its presence is the wire-level
   * discriminator between internal and external tool calls.
   */
  internalToolName?: string;
}

/**
 * `event: tool_call_update` — incremental update for an in-flight
 * tool call. Carries any subset of fields except `toolCallId`
 * (mandatory key). Emitted multiple times per call: status
 * transitions, streaming content blocks, late-arriving locations.
 */
export interface AgentToolCallUpdateEventData {
  toolCallId: string;
  status?: AcpToolCallStatus;
  /** Replace-semantics: new value, if any, supersedes prior `title`. */
  title?: string;
  /**
   * Newly-known content blocks. ACP spec is append-only — UI
   * concatenates these onto whatever `content[]` is already showing.
   */
  content?: AcpToolCallContent[];
  /** Newly-known locations; append-only. */
  locations?: AcpToolCallLocation[];
  /** Raw tool output the agent attached (passed through). */
  rawOutput?: unknown;
}

/**
 * `event: plan` — full plan replacement.
 *
 * ACP plans use REPLACE-semantics: each `plan` event carries the
 * complete current entry list, not a delta. UI keeps only the latest
 * plan emitted in the turn.
 */
export interface AgentPlanEventData {
  entries: AcpPlanEntry[];
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
 * `event: permission_request` — an external (ACP) agent asked the
 * client to approve a tool invocation via `session/request_permission`.
 *
 * The turn pauses on the server while this is outstanding: the agent's
 * `requestPermission` promise is suspended until the user answers (or a
 * server-side timeout cancels it). The web client surfaces an inline
 * approve/deny card and replies out-of-band via
 * `POST /api/acp/threads/:threadId/permission` carrying the same
 * `requestId`.
 *
 * Transient by design — NOT persisted to chat history or the sidecar.
 * A resolved/expired request leaves no trace beyond whatever the agent
 * itself records. Only emitted for external bindings.
 */
export interface AgentPermissionRequestEventData {
  /** Server-generated id, unique within the turn; echoed back on reply. */
  requestId: string;
  /**
   * The tool the agent wants to run (subset of ACP `toolCall`; all optional).
   *
   * `rawInput` is the structured arg payload the agent intends to pass to
   * the tool — typically the most useful field for the user to see (e.g.
   * `{ command: "git status" }` for a shell tool, `{ path, content }` for
   * a write tool). `content` carries optional rich blocks (text / diff /
   * terminal) the agent prepared as a preview, and `locations` lists the
   * files being touched. All three are passed through verbatim; the UI
   * picks a sensible projection.
   */
  toolCall: {
    toolCallId?: string;
    title?: string;
    kind?: AcpToolKind;
    rawInput?: unknown;
    content?: AcpToolCallContent[];
    locations?: AcpToolCallLocation[];
  };
  /** Options offered by the agent; the UI renders one control per option. */
  options: AcpPermissionOption[];
}

// ── External-agent session-meta events ─────────────────────────────────
//
// External (ACP) agents push four kinds of session metadata via
// `session/update` notifications:
//
//   1. `config_option_update`    → 1..n selectable / boolean knobs
//                                  (e.g. Copilot's "model", "mode",
//                                   "thought level", "auto-approve").
//   2. `current_mode_update`     → currently-active mode id (the
//                                  mode list itself lives in
//                                  `availableModes` returned by
//                                  `session/new`).
//   3. `session_info_update`     → human-readable title +
//                                  last-activity timestamp.
//   4. `usage_update`            → token / cost budget for the session.
//
// All four arrive both DURING a turn (translator path) and OUT OF TURN
// (session-listener path). The wire shapes mirror the SDK 1:1; the
// `availableModes` field on `AgentSessionModeUpdateEventData` is
// optional because `current_mode_update` only carries an id — the full
// list comes from the `session/new` / `session/load` response and is
// reconstituted by the server before forwarding.

/**
 * `event: config_options_update` — agent published a fresh snapshot of
 * its selectable configuration options. REPLACE-semantics: the full
 * list supersedes any prior state.
 *
 * Copilot CLI typically pushes four options (model / mode / thought
 * level / auto-approve toggle) shortly after `session/new`; other
 * agents may push fewer or none.
 */
export interface AgentConfigOptionsUpdateEventData {
  options: AcpSessionConfigOption[];
}

/**
 * `event: session_mode_update` — currently-active session mode changed.
 *
 * `availableModes` carries the full mode catalogue when the server has
 * one cached (always true after `session/new` resolves). UI clients
 * key the selector dropdown off `availableModes` and highlight
 * `currentModeId`.
 */
export interface AgentSessionModeUpdateEventData {
  currentModeId: string;
  availableModes?: AcpSessionMode[];
}

/**
 * `event: session_info_update` — title / activity timestamp changed.
 * Both fields are optional per ACP spec (partial updates allowed);
 * `null` explicitly clears the field, `undefined` leaves it unchanged.
 */
export interface AgentSessionInfoUpdateEventData {
  title?: string | null;
  updatedAt?: string | null;
}

/**
 * `event: session_usage_update` — running token / cost budget for the
 * session. UI surfaces these as a context-window gauge.
 */
export interface AgentSessionUsageUpdateEventData {
  /** Tokens used so far. */
  used: number;
  /** Total tokens budgeted for the session. */
  size: number;
  /** Optional cost breakdown (currency + amount). */
  cost?: AcpCost | null;
}

/** Discriminated union of every SSE frame emitted by `/api/agent`. */
export type AgentStreamEvent =
  | { type: 'meta'; data: AgentMetaEventData }
  | { type: 'text_delta'; data: AgentTextDeltaEventData }
  | { type: 'thinking_delta'; data: AgentThinkingDeltaEventData }
  | { type: 'tool_call'; data: AgentToolCallEventData }
  | { type: 'tool_call_update'; data: AgentToolCallUpdateEventData }
  | { type: 'plan'; data: AgentPlanEventData }
  | { type: 'permission_request'; data: AgentPermissionRequestEventData }
  | { type: 'config_options_update'; data: AgentConfigOptionsUpdateEventData }
  | { type: 'session_mode_update'; data: AgentSessionModeUpdateEventData }
  | { type: 'session_info_update'; data: AgentSessionInfoUpdateEventData }
  | { type: 'session_usage_update'; data: AgentSessionUsageUpdateEventData }
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
  ToolCall: 'tool_call',
  ToolCallUpdate: 'tool_call_update',
  Plan: 'plan',
  PermissionRequest: 'permission_request',
  ConfigOptionsUpdate: 'config_options_update',
  SessionModeUpdate: 'session_mode_update',
  SessionInfoUpdate: 'session_info_update',
  SessionUsageUpdate: 'session_usage_update',
  Done: 'done',
  Error: 'error',
  End: 'end',
} as const satisfies Record<string, AgentStreamEventType>;
