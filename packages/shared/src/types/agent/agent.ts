// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Unified Agent Types
 *
 * Types for the pi-ai powered unified agent that handles
 * ask and operate (canvas manipulation) modes.
 *
 * ── Derivation from `@agenetes/protocol` (§7 M2 / M1 acceptance ③) ──
 *
 * The `AgentStreamEvent` union and its per-event `*EventData` payloads are
 * NOT hand-written here: they are DERIVED from the frozen, driver-agnostic
 * `@agenetes/protocol` wire contract via `z.infer` (imported as `import
 * type`, so this file — and the web bundle — stays zod-free, per
 * api-design.md). This makes the protocol schema the single source of truth
 * and guarantees the shared mirror cannot drift from it.
 *
 * Two host-specific fields are the ONLY additions over the protocol core
 * (the protocol deliberately omits them as host extensions):
 *   - `meta.mode` — canvas interaction mode ('ask' | 'operate').
 *   - `tool_call.internalToolName` — client render-variant dispatch.
 *
 * One host override: `meta.threadId` is widened back to a plain `string`.
 * The protocol brands it (`ThreadId`) to enforce the L1↔L2 wire seam, but
 * inside the host the id flows as a plain string, so the shell overrides it
 * to avoid churning every producer with a brand cast.
 */

import type { AgentStreamEvent as ProtocolStreamEvent } from '@agenetes/protocol';

// ==================== Agent Modes ====================

export type AgentMode = 'ask' | 'operate';

export interface AgentConversationAnchor {
  canvasId: string;
  nodeId: string;
}

/**
 * One visible chat presentation whose durable conversation may be owned by
 * another Canvas. The owner controls history, execution, tools, and writes;
 * the presentation anchor controls only where the conversation was opened.
 */
export interface AgentConversationView {
  presentationAnchor: AgentConversationAnchor;
  conversationOwner: AgentConversationAnchor & { threadId: string };
}

// ==================== Streaming Events ====================
//
// SSE events emitted by the unified `/api/agent` endpoint, modelled as a
// discriminated union so both server (`yield`) and client (`switch`)
// receive narrow, exact payloads per event type. Per-event payloads are
// derived from the protocol schema (see the file header); the field-level
// documentation lives on the protocol's zod schemas.

/** The `data` payload of a given protocol stream-event `type`. */
type ProtocolEventData<T extends ProtocolStreamEvent['type']> = Extract<
  ProtocolStreamEvent,
  { type: T }
>['data'];

/**
 * `event: meta` — sent once at the start of every stream. Host shell: the
 * protocol's branded `threadId` is widened back to a plain `string`, and
 * the canvas interaction `mode` is added as a host extension.
 */
export interface AgentMetaEventData extends Omit<
  ProtocolEventData<'meta'>,
  'threadId'
> {
  threadId: string;
  mode: AgentMode;
}

/** `event: text_delta` — incremental assistant text. */
export type AgentTextDeltaEventData = ProtocolEventData<'text_delta'>;

/** `event: thinking_delta` — incremental "thinking" / reasoning text. */
export type AgentThinkingDeltaEventData = ProtocolEventData<'thinking_delta'>;

/**
 * `event: tool_call` — agent declared a tool invocation.
 *
 * Host shell over the protocol payload with one added field:
 * `internalToolName`. Render-variant dispatch happens client-side via
 * {@link variantForInternalTool} keyed on it — internal-agent turns set it
 * and materialise as their dedicated variant (`space_commands`,
 * `agent_tool`, …); external ACP turns leave it undefined and always render
 * as `generic`, so its presence is the wire-level discriminator between
 * internal and external tool calls.
 */
export interface AgentToolCallEventData extends ProtocolEventData<'tool_call'> {
  /**
   * Stable tool name from the internal agent (`space_commands`,
   * `web_search`, `read`, `grep`, …). Drives client-side render-variant
   * dispatch via `variantForInternalTool()` and gates local side-effects
   * (e.g. `space_commands` execution). Undefined for external ACP turns.
   */
  internalToolName?: string;
}

/**
 * `event: tool_call_update` — incremental update for an in-flight
 * tool call. Carries any subset of fields except `toolCallId`
 * (mandatory key). Emitted multiple times per call: status
 * transitions, streaming content blocks, late-arriving locations.
 */
export type AgentToolCallUpdateEventData =
  ProtocolEventData<'tool_call_update'>;

/**
 * `event: plan` — full plan replacement. ACP plans use REPLACE-semantics:
 * each `plan` event carries the complete current entry list, not a delta.
 */
export type AgentPlanEventData = ProtocolEventData<'plan'>;

/** `event: done` — final assistant message + run-level metadata. */
export type AgentDoneEventData = ProtocolEventData<'done'>;

/** `event: error` — server-side error during streaming or tool execution. */
export type AgentErrorEventData = ProtocolEventData<'error'>;

/** `event: end` — sentinel terminator (always last). */
export type AgentEndEventData = ProtocolEventData<'end'>;

/**
 * `event: permission_request` — an external (ACP) agent asked the client to
 * approve a tool invocation via `session/request_permission`. The turn
 * pauses on the server while this is outstanding. Transient by design — NOT
 * persisted. Only emitted for external bindings.
 */
export type AgentPermissionRequestEventData =
  ProtocolEventData<'permission_request'>;

/**
 * `event: config_options_update` — agent published a fresh snapshot of its
 * selectable configuration options (REPLACE-semantics).
 */
export type AgentConfigOptionsUpdateEventData =
  ProtocolEventData<'config_options_update'>;

/** `event: session_mode_update` — currently-active session mode changed. */
export type AgentSessionModeUpdateEventData =
  ProtocolEventData<'session_mode_update'>;

/** `event: session_info_update` — title / activity timestamp changed. */
export type AgentSessionInfoUpdateEventData =
  ProtocolEventData<'session_info_update'>;

/**
 * `event: session_usage_update` — running token / cost budget for the
 * session. UI surfaces these as a context-window gauge.
 */
export type AgentSessionUsageUpdateEventData =
  ProtocolEventData<'session_usage_update'>;

/**
 * Discriminated union of every SSE frame emitted by `/api/agent`. Derived
 * from the protocol union: identical `{ type, data }` frames, with the two
 * host-extended payloads (`meta`, `tool_call`) substituted in.
 */
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
