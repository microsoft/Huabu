/**
 * `AgentHandle` — the in-process L1↔L2 execution seam (§3.6.2).
 *
 * This is the M2 *execution* seam only: the latent common interface that
 * both agent backends already satisfy, made explicit without changing
 * behaviour. It is deliberately NOT the full §3.6 factory model
 * (`driver.create(spec)` + registry): the backing runtime instance (a
 * pi-agent-core `Agent` for the built-in path, an ACP session `entry` for
 * the external path) is constructed by the route and injected into the
 * concrete handle's constructor. Moving that loading into a `create(spec)`
 * factory (control-plane leak #4) needs the host resources it touches to be
 * injectable, which is the M4 (canvas DI) / M5 (package boundary) work — so
 * it is explicitly deferred.
 *
 * A handle models the ACP *client role* (stateful, bidirectional,
 * capability-negotiated), not an HTTP client. Its four facets:
 *
 *   - `submit(request, render)` — the data-plane IN. The request is plain,
 *     replayable data (M2: the host {@link ChatEnvelope}; M3 swaps it for
 *     the driver-agnostic `@agenetes/protocol` request union). `render` is
 *     supplied explicitly per turn and invoked at the last moment — the
 *     handle never owns rendering. Its output shape is backend-specific
 *     (pi-ai `Message[]` for the built-in path; ACP prompt blocks for the
 *     external path), captured by the {@link TRendered} type parameter.
 *   - `events()` — the data-plane OUT: the per-turn `AgentStreamEvent`
 *     stream, returning this turn's transcript delta as the generator's
 *     return value (identical to today's `runAgent` / `runAcpAgent`).
 *   - `control(msg)` — the control plane: host→agent operations over the
 *     `@agenetes/protocol` `ControlMsg` vocabulary, gated by
 *     {@link AgentHandle.capabilities}.
 *   - `capabilities` — the advertised capability descriptor (a built-in Job
 *     advertises only `cancel`; an ACP Deployment advertises the full set).
 *
 * See docs/proposals/layered-architecture.md §3.6 / §7 (M2).
 */

import type { ChatEnvelope } from '../conversation/envelope.js';
import type {
  AgentCapabilities,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentStreamEvent } from '@sediment/shared';

/**
 * The per-turn request a handle accepts. M2 uses the host
 * {@link ChatEnvelope} as a placeholder; M3 replaces it with the
 * driver-agnostic `@agenetes/protocol` request union (the `submit`
 * signature stays the same — only the request's provenance changes).
 */
export type AgentRequest = ChatEnvelope;

/**
 * Turns a (non-null) {@link AgentRequest} into the backend-native payload a
 * handle feeds its runtime. Supplied explicitly to
 * {@link AgentHandle.submit} — render belongs to the caller, not the
 * handle. It is only ever invoked for a non-null request, so it never has
 * to model the "no new input" case (see {@link AgentHandle.submit}). M2
 * renders default to pass-through (the existing `renderEnvelopeMessages` /
 * `prepareExternalAgentPrompt`).
 */
export type RenderFn<TRendered> = (
  request: AgentRequest,
) => TRendered | Promise<TRendered>;

/**
 * The in-process handle to one live agent workload. `TRendered` is the
 * backend-native render output (pi-ai `Message[]` for the built-in path,
 * ACP prompt blocks for the external path). After `submit`, callers use
 * the uniform `events()` / `control()` / `capabilities` facets, which are
 * `TRendered`-agnostic.
 */
export interface AgentHandle<TRendered = unknown> {
  /**
   * Start this turn. When `request` is non-null, renders it via `render`
   * at the last moment and feeds the result to the backing runtime
   * (built-in: `agent.prompt`; external: `client.prompt`).
   *
   * `request` MAY be `null`, meaning "no new input this turn". The
   * interface fixes only that null is *accepted*; its meaning is entirely
   * driver-defined and carries NO protocol-level contract. A driver is
   * free to treat it as "resume the pre-loaded transcript" (the built-in
   * path calls `agent.continue()`), or to reject it (a driver that always
   * needs fresh input may emit an `error` event or no-op). When `request`
   * is null, `render` is never invoked.
   *
   * Non-blocking — the emitted events are consumed via
   * {@link AgentHandle.events}.
   */
  submit(request: AgentRequest | null, render: RenderFn<TRendered>): void;

  /**
   * The per-turn event stream. Yields `AgentStreamEvent`s as the agent
   * produces them and returns this turn's transcript delta (the messages
   * to persist) as the generator's return value.
   */
  events(): AsyncGenerator<AgentStreamEvent, Message[]>;

  /**
   * Send a host→agent control operation. Resolves to a `ControlAck`;
   * unsupported operations (not in `capabilities.control`) resolve to
   * `{ ok: false, code: 'unsupported' }` rather than throwing.
   */
  control(msg: ControlMsg): Promise<ControlAck>;

  /** The capability descriptor this handle advertises. */
  readonly capabilities: AgentCapabilities;
}
