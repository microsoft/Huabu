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

// ─── Internal tool nominal union ──────────────────────────────────────
//
// Sediment's built-in agent (pi-ai) exposes a fixed catalogue of tools
// in `apps/server/src/modules/agent/tools/definitions.ts` (`TOOL_REGISTRY`).
// External (ACP) agents emit their own free-form tool names — we never
// remap those into this union.
//
// **Why a nominal union?** Three callers benefit from compile-time
// narrowing:
//
//   1. The UI's `MergedAgentToolRow` / `CanvasCommandCard` /
//      `WebSearchToolDisplay` switch on this string to pick the
//      pre-existing rich renderer (the `internalToolName` escape
//      hatch). Spelling drift breaks rendering silently.
//   2. The sidecar replay path tags each persisted `kind:'tool'`
//      part with `internalToolName` ONLY when this string matches a
//      registered internal tool — the `JSON.parse(toolResult)`
//      reconstruction of `internalToolData` is unsafe for arbitrary
//      external payloads.
//   3. The streaming translator can short-circuit `tool_call` →
//      `tool_start` legacy event emission for internal turns when
//      the pi-ai bridge migrates over (this file only defines the
//      surface).
//
// **Source of truth.** This union must stay in lock-step with
// `TOOL_REGISTRY`. If a new internal tool is added, append it here
// AND the `INTERNAL_AGENT_TOOL_NAMES` runtime tuple below, or the
// type guard goes stale.
export const INTERNAL_AGENT_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'inspect_nodes',
  'inspect_edges',
  'get_canvas_outline',
  'canvas_commands',
  'web_search',
] as const satisfies readonly string[];

export type InternalAgentToolName = (typeof INTERNAL_AGENT_TOOL_NAMES)[number];

/**
 * Runtime type guard for {@link InternalAgentToolName}. The narrowing
 * is the whole point — callers want `if (isInternalAgentToolName(x))`
 * to flow `x` into the rich rendering path. Cheap O(N) over 9 elements.
 */
export function isInternalAgentToolName(
  value: unknown,
): value is InternalAgentToolName {
  return (
    typeof value === 'string' &&
    (INTERNAL_AGENT_TOOL_NAMES as readonly string[]).includes(value)
  );
}

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
 * tool calls (translator picks the right shape; renderers pick the
 * right path via {@link AssistantToolPart.internalToolName}).
 *
 * The `internalToolName` / `internalToolData` / `permission` fields
 * are the escape hatches — the pre-existing rich renderers
 * (CanvasCommandCard, WebSearchToolDisplay, MergedAgentToolRow)
 * keep working unchanged; the future renderer dispatch will wire
 * them.
 */
export interface AssistantToolPart {
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

  // ── Internal-agent escape hatch ────────────────────────────────────
  /**
   * Non-null iff this tool call came from Sediment's built-in pi-ai
   * agent AND the name matches a known internal tool. Renderers use
   * this to dispatch to the pre-existing
   * `CanvasCommandCard` / `WebSearchToolDisplay` / `MergedAgentToolRow`
   * components without dragging their internal state into the ACP
   * surface.
   */
  internalToolName?: InternalAgentToolName;
  /**
   * Decoded `ToolResponse<…>` payload reconstructed from the pi-ai
   * `ToolResultMessage` (parsed JSON), surfaced only when
   * {@link internalToolName} is set. The reconstruction step lives
   * in the future history builder; this file only reserves the
   * field. Typed as `unknown` because the discriminator is
   * `internalToolName` and the actual shape lives in
   * `types/agent/tools.ts`.
   */
  internalToolData?: unknown;

  // ── Permission gate ────────────────────────────────────────────────
  /**
   * Decision recorded by the auto-allow handler today, or by a
   * future user-driven UI gate. Present only when the agent actually
   * requested permission for this call.
   */
  permission?: ToolPermissionState;
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
