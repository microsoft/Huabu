/**
 * Per-turn ACP overlay accumulator + tool-extension merge helpers.
 *
 * These pure data helpers capture the ACP-specific subset of a
 * `tool_call` / `tool_call_update` payload that does NOT round-trip
 * through pi-ai's message model — the semantic envelope (`toolKind`,
 * lifecycle `status`, source `locations`, structured `content`) plus any
 * permission decision — and accumulate it (keyed by `toolCallId`) into a
 * mutable per-turn overlay as stream events arrive.
 *
 * They travel with the ACP driver (the producer of the events) so the
 * host store that persists the overlay onto a turn record consumes them
 * from here rather than re-declaring them.
 */

import type {
  PlanEntry as AcpPlanEntry,
  ToolCallContent as AcpToolCallContent,
  ToolCallLocation as AcpToolCallLocation,
  ToolCallStatus as AcpToolCallStatus,
  ToolKind as AcpToolKind,
} from '@agentclientprotocol/sdk';

/**
 * A finalised permission decision attached to a tool segment.
 *
 * Mirrors the host `ToolPermissionState` shape (structurally
 * interchangeable) so the driver stays free of host imports.
 */
export interface ToolPermissionState {
  /** ACP option id picked by either the server auto-allow or the user. */
  optionId: string;
  /** Orientation reported by the agent for the picked option. */
  optionKind?: 'allow_always' | 'allow_once' | 'reject_once' | 'reject_always';
  /**
   * `selected` — user/server chose an option (only case today).
   * `cancelled` — turn was aborted before any decision.
   */
  outcome: 'selected' | 'cancelled';
  /** Whether this decision was auto-made by the server or surfaced to the user. */
  source: 'auto-allow' | 'user';
  /** Wall-clock millis when the decision was finalised. */
  decidedAt: number;
}

/**
 * The ACP-specific subset of a `tool_call` / `tool_call_update` payload
 * that does NOT round-trip through pi-ai's `ToolResultMessage`: the
 * semantic envelope (`toolKind`, lifecycle `status`, source `locations`,
 * structured `content`) plus any permission decision. Stored on the
 * turn record (keyed by `toolCallId`) so external-agent tool calls
 * re-render with their rich UI on reload.
 *
 * Append-only fields (`locations`, `content`) merge with prior values
 * via {@link mergeToolExtension}; replace-semantics fields (`status`,
 * `toolKind`, `permission`, `rawOutput`) overwrite.
 */
export interface ToolAcpExtension {
  toolKind?: AcpToolKind;
  status?: AcpToolCallStatus;
  locations?: AcpToolCallLocation[];
  content?: AcpToolCallContent[];
  rawOutput?: unknown;
  permission?: ToolPermissionState;
}

/**
 * Merge two {@link ToolAcpExtension} values. Append-only fields
 * (`locations`, `content`) concatenate; replace-semantics fields
 * overwrite when the new value is defined.
 */
export function mergeToolExtension(
  prev: ToolAcpExtension,
  next: ToolAcpExtension,
): ToolAcpExtension {
  return {
    toolKind: next.toolKind ?? prev.toolKind,
    status: next.status ?? prev.status,
    locations:
      next.locations !== undefined
        ? [...(prev.locations ?? []), ...next.locations]
        : prev.locations,
    content:
      next.content !== undefined
        ? [...(prev.content ?? []), ...next.content]
        : prev.content,
    rawOutput: next.rawOutput !== undefined ? next.rawOutput : prev.rawOutput,
    permission: next.permission ?? prev.permission,
  };
}

/**
 * Mutable per-turn ACP overlay accumulator. The external-agent dispatch
 * (`AcpAgentHandle.run`) mutates this in place as tool / plan events
 * arrive; the route folds it into the persisted turn record. Keyed by
 * stable ids — no timestamps, no position arrays.
 */
export interface AcpTurnOverlay {
  toolExtras: Record<string, ToolAcpExtension>;
  plan?: AcpPlanEntry[];
}

/** Construct an empty {@link AcpTurnOverlay}. */
export function emptyAcpOverlay(): AcpTurnOverlay {
  return { toolExtras: {} };
}

/**
 * Upsert (merge) a tool extension into the overlay in place, keyed by
 * `toolCallId`.
 */
export function applyToolExt(
  overlay: AcpTurnOverlay,
  toolCallId: string,
  extension: ToolAcpExtension,
): void {
  const prev = overlay.toolExtras[toolCallId];
  overlay.toolExtras[toolCallId] = prev
    ? mergeToolExtension(prev, extension)
    : extension;
}
