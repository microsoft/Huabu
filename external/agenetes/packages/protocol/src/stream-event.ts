// The `AgentStreamEvent` contract — the L2->L1 downstream event stream a
// running agent emits for one turn. See docs/proposals/layered-architecture.md
// §3.6 / §5.
//
// Every frame is a `{ type, data }` envelope discriminated on `type`. This
// package owns only the THIN envelope union and the driver-agnostic core
// payloads; the ACP-shaped payloads (tool calls, plans, permission requests,
// session-meta) reference the Agent Client Protocol SDK's own zod schemas so
// the shapes cannot drift from the standard. The `{ type, data }` layer is a
// deliberately thin shell: if the SDK bumps a payload shape, only the
// referenced `ZAcp*` schema moves — our envelope is unaffected.
//
// Host-specific fields are NOT upstream here. Two fields in Sediment's mirror
// are canvas/product concepts, not protocol core, and stay as host
// extensions (the host `.extend()`s the exported per-event data schema and
// re-assembles the union):
//   - `meta.data.mode` ('ask' | 'operate') — canvas interaction mode.
//   - `tool_call.data.internalToolName` — client render-variant dispatch.
//
// "Protocol gives the blocks, the host composes." The 14 event TYPES are a
// closed protocol vocabulary; the host may only widen individual payloads
// with optional fields, never add new event types out-of-band.

import {
  zCost as ZAcpCost,
  zPermissionOption as ZAcpPermissionOption,
  zPlanEntry as ZAcpPlanEntry,
  zSessionConfigOption as ZAcpSessionConfigOption,
  zSessionMode as ZAcpSessionMode,
  zToolCallContent as ZAcpToolCallContent,
  zToolCallLocation as ZAcpToolCallLocation,
  zToolCallStatus as ZAcpToolCallStatus,
  zToolKind as ZAcpToolKind,
} from '@agentclientprotocol/sdk/dist/schema/zod.gen.js';
import { z } from 'zod';

import { threadIdSchema } from './identity.js';

// ── Per-event data payloads ────────────────────────────────────────────
//
// Exported individually so a host can narrow a specific payload or
// `.extend()` it with a host-specific field before re-assembling the union.

/** `meta` — sent once at the start of every stream. */
export const metaEventDataSchema = z.object({
  threadId: threadIdSchema,
});

/** `text_delta` — incremental assistant text. */
export const textDeltaEventDataSchema = z.object({
  content: z.string(),
});

/** `thinking_delta` — incremental "thinking" / reasoning text. */
export const thinkingDeltaEventDataSchema = z.object({
  content: z.string(),
});

/**
 * `tool_call` — agent declared a tool invocation. The unified wire shape
 * for both internal and external (ACP) tool calls: a stable `toolCallId`,
 * semantic `toolKind`, lifecycle `status`, source `locations`, and rich
 * `content` blocks. ACP-shaped fields reference the SDK zod directly.
 */
export const toolCallEventDataSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  /** Shell command behind the title, derived server-side from `rawInput`. */
  command: z.string().optional(),
  toolKind: ZAcpToolKind.optional(),
  status: ZAcpToolCallStatus.optional(),
  locations: z.array(ZAcpToolCallLocation).optional(),
  content: z.array(ZAcpToolCallContent).optional(),
  /** Raw arguments the agent attached (passed through unmodified). */
  rawInput: z.unknown().optional(),
});

/**
 * `tool_call_update` — incremental update for an in-flight tool call.
 * Carries any subset of fields except `toolCallId` (the mandatory key).
 */
export const toolCallUpdateEventDataSchema = z.object({
  toolCallId: z.string(),
  status: ZAcpToolCallStatus.optional(),
  title: z.string().optional(),
  content: z.array(ZAcpToolCallContent).optional(),
  locations: z.array(ZAcpToolCallLocation).optional(),
  rawOutput: z.unknown().optional(),
});

/** `plan` — full plan replacement (ACP plans use REPLACE-semantics). */
export const planEventDataSchema = z.object({
  entries: z.array(ZAcpPlanEntry),
});

/**
 * `permission_request` — an external (ACP) agent asked the client to
 * approve a tool invocation. Transient by design; only emitted for
 * external bindings.
 */
export const permissionRequestEventDataSchema = z.object({
  /** Server-generated id, unique within the turn; echoed back on reply. */
  requestId: z.string(),
  toolCall: z.object({
    toolCallId: z.string().optional(),
    title: z.string().optional(),
    kind: ZAcpToolKind.optional(),
    rawInput: z.unknown().optional(),
    content: z.array(ZAcpToolCallContent).optional(),
    locations: z.array(ZAcpToolCallLocation).optional(),
  }),
  options: z.array(ZAcpPermissionOption),
});

/**
 * `config_options_update` — agent published a fresh snapshot of its
 * selectable configuration options (REPLACE-semantics).
 */
export const configOptionsUpdateEventDataSchema = z.object({
  options: z.array(ZAcpSessionConfigOption),
});

/**
 * `session_mode_update` — currently-active session mode changed.
 * `availableModes` carries the full catalogue when the server has one.
 */
export const sessionModeUpdateEventDataSchema = z.object({
  currentModeId: z.string(),
  availableModes: z.array(ZAcpSessionMode).optional(),
});

/**
 * `session_info_update` — title / activity timestamp changed. Both fields
 * are optional per ACP spec; `null` clears, `undefined` leaves unchanged.
 */
export const sessionInfoUpdateEventDataSchema = z.object({
  title: z.string().nullish(),
  updatedAt: z.string().nullish(),
});

/** `session_usage_update` — running token / cost budget for the session. */
export const sessionUsageUpdateEventDataSchema = z.object({
  used: z.number(),
  size: z.number(),
  cost: ZAcpCost.nullish(),
});

/** `done` — final assistant message + run-level metadata. */
export const doneEventDataSchema = z.object({
  message: z.string(),
  meta: z
    .object({
      stopReason: z.string().optional(),
      usage: z.unknown().optional(),
      iterations: z.number().optional(),
    })
    .optional(),
});

/** `error` — server-side error during streaming or tool execution. */
export const errorEventDataSchema = z.object({
  error: z.string(),
});

/** `end` — sentinel terminator (always last). */
export const endEventDataSchema = z.object({});

// ── Envelope union ─────────────────────────────────────────────────────

/**
 * Canonical event-name constants. Use these instead of string literals so
 * a typo or rename is a compile-time error.
 */
export const AGENT_STREAM_EVENTS = {
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
} as const;

/**
 * The driver-agnostic `AgentStreamEvent` wire union — every SSE frame a
 * running agent emits, discriminated on `type`. The 14 event types are a
 * closed protocol vocabulary; hosts widen individual payloads via the
 * exported per-event data schemas, never add types out-of-band.
 */
export const agentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), data: metaEventDataSchema }),
  z.object({ type: z.literal('text_delta'), data: textDeltaEventDataSchema }),
  z.object({
    type: z.literal('thinking_delta'),
    data: thinkingDeltaEventDataSchema,
  }),
  z.object({ type: z.literal('tool_call'), data: toolCallEventDataSchema }),
  z.object({
    type: z.literal('tool_call_update'),
    data: toolCallUpdateEventDataSchema,
  }),
  z.object({ type: z.literal('plan'), data: planEventDataSchema }),
  z.object({
    type: z.literal('permission_request'),
    data: permissionRequestEventDataSchema,
  }),
  z.object({
    type: z.literal('config_options_update'),
    data: configOptionsUpdateEventDataSchema,
  }),
  z.object({
    type: z.literal('session_mode_update'),
    data: sessionModeUpdateEventDataSchema,
  }),
  z.object({
    type: z.literal('session_info_update'),
    data: sessionInfoUpdateEventDataSchema,
  }),
  z.object({
    type: z.literal('session_usage_update'),
    data: sessionUsageUpdateEventDataSchema,
  }),
  z.object({ type: z.literal('done'), data: doneEventDataSchema }),
  z.object({ type: z.literal('error'), data: errorEventDataSchema }),
  z.object({ type: z.literal('end'), data: endEventDataSchema }),
]);

/** The `AgentStreamEvent` union type, derived from the wire schema. */
export type AgentStreamEvent = z.infer<typeof agentStreamEventSchema>;

/** The set of `AgentStreamEvent` discriminants. */
export type AgentStreamEventType = AgentStreamEvent['type'];
