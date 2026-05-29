/**
 * Assistant message parts — the data model the chat pipeline uses to
 * render an assistant turn as an ordered sequence of segments
 * (text / thinking / tool / plan / status), instead of one opaque
 * blob of markdown.
 *
 * Defined here so the translator (server) and the sidecar
 * persistence layer can produce/consume them. `ChatHistoryItem`
 * itself is NOT yet switched to use these — that swap is a
 * follow-up change, kept separate to keep this addition
 * type-only and not destabilise existing UI rendering.
 */

import type {
  AcpContentBlock,
  AcpPlanEntry,
  AcpToolCallContent,
  AcpToolCallLocation,
  AcpToolCallStatus,
  AcpToolKind,
} from './acp-tool.js';
import type { ToolResponse, WebSearchToolResponse } from './tools.js';

// ─── Permission outcome ───────────────────────────────────────────────
//
// Mirrors the ACP `RequestPermissionResponse.outcome` discriminator
// plus the `optionId` echoed back. Recorded ALONGSIDE the tool part so
// a refresh can show "allow_once auto-decided" / "rejected by user"
// without re-running the request.
//
// Today this captures the auto-allow handler's current decision
// unchanged. When a real UI-gating layer lands it will populate this
// with user choices — keeping the field on `AssistantPart` from day
// one avoids a wire migration later.

/** A finalised permission decision attached to a tool segment. */
export interface ToolPermissionState {
  /** ACP option id picked by either the server auto-allow or the user. */
  optionId: string;
  /** Orientation reported by the agent for the picked option. */
  optionKind?: 'allow_always' | 'allow_once' | 'reject_once' | 'reject_always';
  /**
   * `selected` — user/server chose an option (only case today).
   * `cancelled` — turn was aborted before any decision; the agent will
   *               receive `outcome: 'cancelled'` per ACP §session/request_permission.
   */
  outcome: 'selected' | 'cancelled';
  /** Whether this decision was auto-made by the server or surfaced to the user. */
  source: 'auto-allow' | 'user';
  /** Wall-clock millis when the decision was finalised. */
  decidedAt: number;
}

// ─── AssistantPart (client / store shape) ─────────────────────────────
//
// The discriminated union the chat store / segments aggregator
// produces from the SSE stream. Mirrors `AssistantHistoryPart` 1:1 in
// shape; kept as two named types so future server-only fields (e.g.
// raw stop-reason cursor) can grow on one side without leaking to the
// other. Right now the fields are identical and we type-alias them.

/** A single segment within an assistant turn. */
export type AssistantPart =
  | AssistantTextPart
  | AssistantThinkingPart
  | AssistantToolPart
  | AssistantPlanPart
  | AssistantStatusPart;

/** Markdown body chunk emitted by `text_delta`. */
export interface AssistantTextPart {
  kind: 'text';
  text: string;
}

/** Hidden reasoning emitted by `thinking_delta`. */
export interface AssistantThinkingPart {
  kind: 'thinking';
  text: string;
}

/** A single plan list (`Plan` per ACP §session/update). */
export interface AssistantPlanPart {
  kind: 'plan';
  entries: AcpPlanEntry[];
}

/** Status segments (interruption / error notice). Already lives in
 *  `ChatHistoryItem.role:'status'`; mirrored here so the future
 *  reconstruction layer can emit it as a structural part. */
export interface AssistantStatusPart {
  kind: 'status';
  status: 'interrupted' | 'error';
  detail?: string;
}

/**
 * A tool call — covers BOTH external ACP tool calls AND internal pi-ai
 * tool calls. Modelled as a discriminated union (`variant`) so each
 * tool family with a dedicated rich renderer carries its OWN typed
 * payload and downstream code never has to re-classify or cast.
 *
 * Variants:
 *  - `generic`          — external ACP tools and any internal tool
 *                         without a dedicated rich renderer.
 *  - `agent_tool`       — built-in pi-ai agent tools (`read`, `grep`,
 *                         `find`, `ls`, `inspect_nodes`,
 *                         `inspect_edges`, `get_canvas_outline`).
 *  - `canvas_commands`  — the canvas mutation tool, rendered as a
 *                         change list with revert/keep/preview.
 *  - `web_search`       — the web search tool, rendered as a
 *                         draggable source list.
 *
 * Producer responsibility (server `buildHistoryItems`, client
 * `useAgentStream`, sketch-cluster synthesizer): map the pi-ai tool
 * name through {@link variantForInternalTool} once and emit the
 * matching variant — downstream the type system enforces correct
 * access without runtime checks or casts.
 */
export type AssistantToolPart =
  | GenericToolPart
  | AgentToolPart
  | CanvasCommandsToolPart
  | WebSearchToolPart;

/** Shared lifecycle/identity fields carried by every tool variant. */
interface ToolPartBase {
  kind: 'tool';
  /** Stable per-call id; pairs `tool_call` with later `tool_call_update`. */
  toolCallId: string;
  /** Human-readable title from the agent (e.g. `Read app.ts`). */
  title: string;
  /** ACP semantic kind (`read`, `edit`, `search`, …); undefined for legacy. */
  toolKind?: AcpToolKind;
  /** Lifecycle status; defaults to `pending` until first update. */
  status?: AcpToolCallStatus;
  /** Source-locations the tool touched, in declaration order. */
  locations?: AcpToolCallLocation[];
  /** Rich content blocks (text/image/diff/terminal) produced by the tool. */
  content?: AcpToolCallContent[];
  /** Free-form payload the agent attached for later replay. */
  rawOutput?: unknown;
  /**
   * Decision recorded by the auto-allow handler today, or by a
   * future user-driven UI gate. Present only when the agent actually
   * requested permission for this call.
   */
  permission?: ToolPermissionState;
}

/**
 * External ACP tool call, or any tool without a dedicated rich
 * renderer. Rendered by the generic `ToolCallCard` using `content[]`
 * and `locations[]` per ACP §session/update.
 */
export interface GenericToolPart extends ToolPartBase {
  variant: 'generic';
}

/**
 * Built-in pi-ai agent tool (`read` / `grep` / `find` / `ls` /
 * `inspect_*` / `get_canvas_outline`). Rendered by
 * `MergedAgentToolRow` which merges adjacent calls of the SAME
 * {@link toolName} into one collapsible row.
 */
export interface AgentToolPart extends ToolPartBase {
  variant: 'agent_tool';
  /** Specific built-in tool name; used as the merge key. */
  toolName: string;
  /**
   * `ToolResponse<…>` envelope from the pi-ai bridge. Undefined
   * between `tool_start` (no result yet) and the first provisional
   * args; populated by `tool_result` with the real payload.
   */
  data?: ToolResponse<string, unknown>;
}

/**
 * The `canvas_commands` tool. Rendered by `CanvasCommandCard` as a
 * change list with revert / keep / preview controls.
 *
 * Live `canvasChanges` (and the originating `commands[]`) are nested
 * inside `data.data` per the `ToolResponse` envelope — this is the
 * canonical home for both, so the renderer's mutate-in-place revert
 * flow targets that single path.
 */
export interface CanvasCommandsToolPart extends ToolPartBase {
  variant: 'canvas_commands';
  data?: ToolResponse<'canvas_commands', Record<string, unknown>>;
}

/**
 * The `web_search` tool. Rendered by `WebSearchToolDisplay` as a
 * draggable source list (each result can be dragged onto the canvas
 * to create a `web` node).
 */
export interface WebSearchToolPart extends ToolPartBase {
  variant: 'web_search';
  data?: WebSearchToolResponse;
}

// ─── Variant resolution ───────────────────────────────────────────────
//
// Single source of truth shared by every producer (server history
// reconstruction, client SSE stream merger, sketch-cluster synthesizer)
// so the mapping from a pi-ai built-in tool name to its render variant
// lives in exactly one place. External ACP tools never go through
// this — they always carry `variant: 'generic'` directly.

/** The render-variant tag carried by {@link AssistantToolPart}. */
export type AssistantToolVariant = AssistantToolPart['variant'];

const VARIANT_BY_INTERNAL_TOOL: Record<string, AssistantToolVariant> = {
  canvas_commands: 'canvas_commands',
  web_search: 'web_search',
  read: 'agent_tool',
  grep: 'agent_tool',
  find: 'agent_tool',
  ls: 'agent_tool',
  inspect_nodes: 'agent_tool',
  inspect_edges: 'agent_tool',
  get_canvas_outline: 'agent_tool',
};

/**
 * Resolve the render variant for a built-in pi-ai tool name.
 * Unknown names — including internal tools added in the future
 * without a dedicated renderer — fall through to `'generic'`.
 */
export function variantForInternalTool(toolName: string): AssistantToolVariant {
  return VARIANT_BY_INTERNAL_TOOL[toolName] ?? 'generic';
}

// ─── AssistantHistoryPart (wire / persistence shape) ──────────────────
//
// The shape `ChatHistoryItem.assistant.parts` will carry once the
// history builder switches over. Kept as a separate type alias
// (rather than reusing AssistantPart) so future divergence is cheap.

/** Wire-shape mirror of {@link AssistantPart}; identical fields
 *  today. The history builder will use this on the `ChatHistoryItem`
 *  payload. */
export type AssistantHistoryPart = AssistantPart;

// ─── ACP content-block helpers ────────────────────────────────────────
//
// Tiny re-export to keep render-time imports concise. UI files only
// need `AcpContentBlock` to type-check tool content; re-exporting from
// here means they import from one place (`@sediment/shared`) rather
// than chasing the SDK alias.
export type { AcpContentBlock };
