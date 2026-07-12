// The `ControlMsg` contract — the L1->L2->agent CONTROL plane: the
// host-to-agent operations that steer a live session (as opposed to the
// per-turn `AgentSubmission` data plane and the agent-to-host
// `AgentStreamEvent` notification stream). See
// docs/proposals/layered-architecture.md §3.6.2.
//
// Like `AgentStreamEvent`, a ControlMsg is a CLOSED protocol vocabulary
// owned by Agenetes (NOT a host-registered `defineX`/`composeX` set): the
// control operations are fixed by the control plane, not extended per
// host. Both flow over one in-process full-duplex channel, so both use the
// SAME `{ type, data }` frame shape — agent->host (`AgentStreamEvent`) and
// host->agent (`ControlMsg`) are symmetric frames on that channel.
//
// Which operations a given agent actually honours is a runtime concern,
// described by {@link AgentCapabilities} (a Job advertises only `cancel`;
// a Deployment advertises the subset it actually honours). Capability
// GATING is enforced by the control plane at call time; this schema only
// fixes the wire SHAPE.

import { z } from 'zod';

// ── Control-operation vocabulary ───────────────────────────────────────

/**
 * Canonical control-operation names. Use these instead of string literals
 * so a typo or rename is a compile-time error.
 */
export const CONTROL_MSGS = {
  Cancel: 'cancel',
  SetMode: 'set_mode',
  SetModel: 'set_model',
  SetConfigOption: 'set_config_option',
  AnswerPermission: 'answer_permission',
  SetContext: 'set_context',
} as const;

/**
 * The set of control-operation discriminants. Also the element type of
 * {@link AgentCapabilities.supportedControlMessages}, which lists exactly
 * the operations an agent honours.
 */
export const controlMsgTypeSchema = z.enum([
  'cancel',
  'set_mode',
  'set_model',
  'set_config_option',
  'answer_permission',
  'set_context',
]);

/** A control-operation discriminant. */
export type ControlMsgType = z.infer<typeof controlMsgTypeSchema>;

// ── Per-operation data payloads ────────────────────────────────────────

/** `cancel` — cancel the in-flight turn. Carries no payload. */
export const cancelControlDataSchema = z.object({});

/**
 * `set_mode` — switch the active session mode. `modeId` is one of the
 * agent-advertised `AcpSessionMode.id`s (from `availableModes` / the
 * `session_mode_update` event). This is the agent-advertised ACP session
 * mode, DISTINCT from the host canvas mode (`meta.mode: 'ask'|'operate'`,
 * a host extension not modelled in this package).
 */
export const setModeControlDataSchema = z.object({
  modeId: z.string(),
});

/** `set_model` — switch the active model; `modelId` is agent-advertised. */
export const setModelControlDataSchema = z.object({
  modelId: z.string(),
});

/**
 * `set_config_option` — set one of the agent's selectable configuration
 * options (from the `config_options_update` event). `value` is a string
 * for enum-style options and a boolean for toggles.
 */
export const setConfigOptionControlDataSchema = z.object({
  optionId: z.string(),
  value: z.union([z.string(), z.boolean()]),
});

/**
 * `answer_permission` — reply to a `permission_request` event. Correlated
 * by `requestId`; `decision` either selects an offered option or cancels.
 */
export const answerPermissionControlDataSchema = z.object({
  requestId: z.string(),
  decision: z.union([
    z.object({ optionId: z.string() }),
    z.object({ cancelled: z.literal(true) }),
  ]),
});

/**
 * `set_context` — update driver-owned live context between turns.
 *
 * Minimal first shape: lets the host refresh a long-lived session's system
 * prompt without recreating it. May grow further optional fields (e.g.
 * tools) as standard use cases emerge.
 */
export const setContextControlDataSchema = z.object({
  systemPrompt: z.string().optional(),
});

// ── Envelope union ─────────────────────────────────────────────────────

/**
 * The host->agent control message — every control frame the host sends to
 * a live session, discriminated on `type`. A closed protocol vocabulary;
 * hosts widen individual payloads via the exported per-operation data
 * schemas, never add operations out-of-band.
 */
export const controlMsgSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cancel'), data: cancelControlDataSchema }),
  z.object({ type: z.literal('set_mode'), data: setModeControlDataSchema }),
  z.object({ type: z.literal('set_model'), data: setModelControlDataSchema }),
  z.object({
    type: z.literal('set_config_option'),
    data: setConfigOptionControlDataSchema,
  }),
  z.object({
    type: z.literal('answer_permission'),
    data: answerPermissionControlDataSchema,
  }),
  z.object({
    type: z.literal('set_context'),
    data: setContextControlDataSchema,
  }),
]);

/** The `ControlMsg` union type, derived from the wire schema. */
export type ControlMsg = z.infer<typeof controlMsgSchema>;

// ── Acknowledgement ────────────────────────────────────────────────────

/**
 * The result of a `control()` call. Minimal by design: success, or a
 * failure carrying a human-readable `error` and an optional machine
 * `code` (e.g. `unsupported`, `unknown_mode`, `timeout`).
 */
export const controlAckSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    code: z.string().optional(),
  }),
]);

/** The `ControlAck` type, derived from the wire schema. */
export type ControlAck = z.infer<typeof controlAckSchema>;

// ── Capabilities descriptor ────────────────────────────────────────────

/**
 * The serializable capability descriptor a realized handle advertises. It
 * is composable: a new host→agent callable capability extends
 * `supportedControlMessages`; a new non-callable behavioural trait adds a
 * field with a conservative default.
 *
 * A `Job` advertises only `{ supportedControlMessages: ['cancel'] }`; a
 * `Deployment` advertises the subset its runtime supports, plus any
 * non-callable traits such as `loadSession`. The Job/Deployment presets
 * are not encoded here — each realized handle reports the descriptor it
 * actually honours.
 */
export const agentCapabilitiesSchema = z.object({
  /**
   * Which control operations the agent honours (subset of the closed
   * `ControlMsg` vocabulary).
   */
  supportedControlMessages: z.array(controlMsgTypeSchema),
  /** Whether the agent can resume a prior session (ACP `loadSession`). */
  loadSession: z.boolean().optional(),
  /**
   * How the agent accepts turn input while a turn is in flight. Behavioural
   * capability; conservative default `'blocking'` (turn-based, the ACP
   * baseline). `'queue'` buffers, `'concurrent'` accepts mid-turn.
   */
  turnInput: z.enum(['blocking', 'queue', 'concurrent']).default('blocking'),
});

/** The `AgentCapabilities` descriptor type, derived from the schema. */
export type AgentCapabilities = z.infer<typeof agentCapabilitiesSchema>;
