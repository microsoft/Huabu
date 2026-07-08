// The `AgentTurn` contract — the FOLDED twin of `AgentStreamEvent`. See
// docs/proposals/layered-architecture.md M5.6 / README I9.8.
//
// `AgentStreamEvent` is the *delta* view of one turn: the fine-grained,
// append-only frames a running agent emits (Tier 1 of the conversation
// log). `AgentTurn` is the *folded* view of the same turn (Tier 2): one
// immutable record per completed `run()`, produced by L2 folding the
// turn's Tier-1 event range together with the run's return transcript.
//
// The two are twins over the SAME event vocabulary. Folding collapses the
// stream's deltas into their accumulated form:
//   - `text_delta`    → one folded `text` message (concatenated content).
//   - `thinking_delta`→ one folded `thinking` message.
//   - `tool_call` + its `tool_call_update`s → one folded `tool_call` in
//     its final state.
//   - `plan`          → the turn's final (replace-semantics) plan.
//   - `error`         → a folded error row.
// Some stream frames are deliberately NOT transcript content and never
// fold in here:
//   - `meta` / `end`  — Tier-1 envelope sentinels, not turn content.
//   - `permission_request` — ephemeral by design (only live, never durable).
//   - `config_options_update` / `session_mode_update` /
//     `session_info_update` / `session_usage_update` — these fold into
//     `AgentMetadata` (README I9.7), the control-plane *state* channel,
//     not the conversation transcript.
//   - `done`          — its message is the last folded `text`; its
//     run-level metadata becomes the turn's top-level `meta`.
//
// SKELETON (M5.6 / C1): this file fixes the `AgentTurn` envelope and the
// `FoldedMessage` union shape. The exact folded-message vocabulary is
// refined as the fold (C3) and the driver transcript translators (C4 ACP /
// C5 built-in) land — hosts widen individual payloads via the exported
// per-member data schemas exactly as they do for `AgentStreamEvent`, never
// adding members out-of-band.

import { z } from 'zod';

import { agentRequestBaseSchema } from './request.js';
import {
  errorEventDataSchema,
  planEventDataSchema,
  textDeltaEventDataSchema,
  thinkingDeltaEventDataSchema,
  toolCallEventDataSchema,
} from './stream-event.js';

// ── Per-folded-message data payloads ───────────────────────────────────
//
// Reuse the `AgentStreamEvent` per-event data schemas wherever the folded
// shape equals the delta shape, so the two tiers cannot drift. Exported
// individually so a host can `.extend()` a payload (e.g. the ACP tool
// overlay, the built-in `internalToolName`) before re-assembling the union.

/** `text` — the folded assistant text (accumulated `text_delta`s). */
export const foldedTextDataSchema = textDeltaEventDataSchema;

/** `thinking` — the folded reasoning text (accumulated `thinking_delta`s). */
export const foldedThinkingDataSchema = thinkingDeltaEventDataSchema;

/**
 * `tool_call` — one tool invocation folded to its final state (the initial
 * `tool_call` with every `tool_call_update` applied). Reuses the stream
 * `tool_call` payload; a folded call additionally carries the final
 * `rawOutput` a `tool_call_update` may have delivered.
 */
export const foldedToolCallDataSchema = toolCallEventDataSchema.extend({
  rawOutput: z.unknown().optional(),
});

/** `plan` — the turn's final full-replacement plan. */
export const foldedPlanDataSchema = planEventDataSchema;

/** `error` — a folded server-side / tool error row. */
export const foldedErrorDataSchema = errorEventDataSchema;

// ── FoldedMessage union ────────────────────────────────────────────────

/**
 * Canonical folded-message-name constants. Use these instead of string
 * literals so a typo or rename is a compile-time error.
 */
export const FOLDED_MESSAGE_TYPES = {
  Text: 'text',
  Thinking: 'thinking',
  ToolCall: 'tool_call',
  Plan: 'plan',
  Error: 'error',
} as const;

/**
 * The driver-agnostic `FoldedMessage` union — one entry in a turn's folded
 * `transcript`, discriminated on `type`, in emission order. It is the
 * folded twin of `AgentStreamEvent`'s content frames: the same `{ type,
 * data }` envelope, over the accumulated (not delta) payloads. Message
 * *order* is the array order; nothing relies on timestamps.
 */
export const foldedMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), data: foldedTextDataSchema }),
  z.object({ type: z.literal('thinking'), data: foldedThinkingDataSchema }),
  z.object({ type: z.literal('tool_call'), data: foldedToolCallDataSchema }),
  z.object({ type: z.literal('plan'), data: foldedPlanDataSchema }),
  z.object({ type: z.literal('error'), data: foldedErrorDataSchema }),
]);

/** The `FoldedMessage` union type, derived from the schema. */
export type FoldedMessage = z.infer<typeof foldedMessageSchema>;

/** The set of `FoldedMessage` discriminants. */
export type FoldedMessageType = FoldedMessage['type'];

// ── AgentTurn envelope ─────────────────────────────────────────────────

/**
 * Run-level metadata for a completed turn — the folded value of the
 * stream's terminal `done` frame (its per-turn message is already the last
 * folded `text`, so only the run metadata is kept here).
 */
export const agentTurnMetaSchema = z.object({
  stopReason: z.string().optional(),
  usage: z.unknown().optional(),
  iterations: z.number().optional(),
});

/**
 * One completed turn: the raw `request` the caller submitted (I6, the
 * driver-agnostic source of truth for replay) plus the folded `transcript`
 * the agent produced in response, and optional run-level `meta`. Only the
 * *assistant/tool* output lives in `transcript`; the user side is rebuilt
 * from `request`, matching how the host rebuilds its `Context` from the
 * envelope. Immutable once written — the Tier-2 checkpoint (README I9.8).
 */
export const agentTurnSchema = z.object({
  request: agentRequestBaseSchema,
  transcript: z.array(foldedMessageSchema),
  meta: agentTurnMetaSchema.optional(),
});

/** The `AgentTurn` record type, derived from the schema. */
export type AgentTurn = z.infer<typeof agentTurnSchema>;
