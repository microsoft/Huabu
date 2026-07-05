// @agenetes/runtime — the host-agnostic L2 agent-runtime framework.
//
// This package owns the *execution seam* (`AgentHandle`) and the *driver
// register / injection seam* (`AgentDriver` + `AgentRuntime`) that sit
// between L1 (the human-AI interface / host app) and L2 (the Agenetes
// control plane). It is the in-process analogue of a container runtime
// framework: L1 injects drivers (object injection today; a clean
// `create(spec)` factory later), and L2 drives every workload uniformly
// through the `AgentHandle` contract.
//
// Design rules (why it lives in the agenetes subtree, mirroring
// @agenetes/protocol):
//   - It is owned by L2 and consumed by L1. A second L2 implementation
//     must be able to satisfy these contracts unchanged.
//   - It must stay host-agnostic: it depends ONLY on `@agenetes/protocol`.
//     It must not import `@sediment/shared`, pi-ai / pi-agent-core, the
//     ACP SDK, or any canvas/Huabu-specific type. Host-shaped types
//     (the request, the render output, the transcript result) enter
//     purely as generic type parameters bound by the host.
//   - Concrete drivers (the built-in pi-agent-core driver, the ACP
//     driver) are NOT built in yet. Standard drivers (e.g. ACP) are
//     destined to ship inside this package once their host couplings
//     (canvas capabilities, transport) become injectable ports; custom
//     drivers (the canvas-coupled built-in agents) are always injected
//     by L1. Until then, both are injected as objects.
//
// See docs/proposals/layered-architecture.md §3.6 / §7.

import type {
  AgentCapabilities,
  AgentStreamEvent,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';

/**
 * Turns a (non-null) request into the backend-native payload a handle
 * feeds its runtime. Supplied explicitly to {@link AgentHandle.submit} —
 * render belongs to the caller, not the handle. It is only ever invoked
 * for a non-null request, so it never has to model the "no new input"
 * case (see {@link AgentHandle.submit}).
 *
 * `TRequest` is the host request shape (the L1↔L2 request contract, kept
 * as a type parameter so this package stays host-agnostic). `TRendered`
 * is the backend-native render output (pi-ai `Message[]` for the built-in
 * path, ACP prompt blocks for the external path).
 */
export type RenderFn<TRequest, TRendered> = (
  request: TRequest,
) => TRendered | Promise<TRendered>;

/**
 * The in-process handle to one live agent workload — the ACP *client
 * role* (stateful, bidirectional, capability-negotiated), not an HTTP
 * client. Its four facets:
 *
 *   - `submit(request, render)` — the data-plane IN. The request is
 *     plain, replayable data; `render` is supplied explicitly per turn
 *     and invoked at the last moment — the handle never owns rendering.
 *   - `events()` — the data-plane OUT: the per-turn `AgentStreamEvent`
 *     stream, returning this turn's transcript delta ({@link TResult}) as
 *     the generator's return value.
 *   - `control(msg)` — the control plane: host→agent operations over the
 *     `@agenetes/protocol` `ControlMsg` vocabulary, gated by
 *     {@link AgentHandle.capabilities}.
 *   - `capabilities` — the advertised capability descriptor.
 *
 * The type parameters keep the framework host-agnostic: `TRequest` is the
 * host request shape, `TRendered` the backend-native render output, and
 * `TResult` the transcript-delta the generator returns (the host binds it
 * to e.g. pi-ai `Message[]`). After `submit`, callers use the uniform
 * `events()` / `control()` / `capabilities` facets, all `TRendered`-agnostic.
 */
export interface AgentHandle<
  TRequest = unknown,
  TRendered = unknown,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
> {
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
  submit(request: TRequest | null, render: RenderFn<TRequest, TRendered>): void;

  /**
   * The per-turn event stream. Yields `AgentStreamEvent`s as the agent
   * produces them and returns this turn's transcript delta (the messages
   * to persist) as the generator's return value.
   *
   * The yield type is a `TEvent` generic (defaulting to the wire-level
   * `@agenetes/protocol` `AgentStreamEvent`) so the host can bind it to a
   * host-extended event union — e.g. one carrying extra tool metadata, or
   * excluding transport-synthesized frames like `meta`/`end`. `TEvent` is
   * constrained to remain protocol-assignable, keeping the wire contract.
   */
  events(): AsyncGenerator<TEvent, TResult>;

  /**
   * Send a host→agent control operation. Resolves to a `ControlAck`;
   * unsupported operations (not in `capabilities.control`) resolve to
   * `{ ok: false, code: 'unsupported' }` rather than throwing.
   */
  control(msg: ControlMsg): Promise<ControlAck>;

  /** The capability descriptor this handle advertises. */
  readonly capabilities: AgentCapabilities;
}
