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
  AgentStateSnapshot,
  AgentStreamEvent,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';

/**
 * The per-turn *session state* a handle hands its `render` closure (the
 * second `render` argument). A stateful render — one whose output depends
 * on where in the session this turn falls — reads it here rather than
 * reaching into driver-owned session state itself. It is deliberately a
 * small, DRIVER-AGNOSTIC descriptor (generic session facts like "is this
 * the first message"), NOT a driver-specific instruction: the driver
 * (L2) *owns* and supplies the state; the render (L1) *interprets* it
 * (e.g. the ACP render maps `isFirstMessage` onto whether to prepend its
 * one-shot system preamble). New generic fields (turn index, resumed-ness)
 * are added here over time; nothing driver-specific belongs on it.
 */
export interface AgentTurnState {
  /**
   * Whether this is, in the session's own reckoning, its first message —
   * i.e. no prior turn has effectively landed yet (a fresh session, not a
   * resumed one). Each driver defines what "first" means for its backend;
   * a render uses it to decide first-turn-only content.
   */
  readonly isFirstMessage: boolean;
}

/**
 * Turns a (non-null) request into the backend-native payload a handle
 * feeds its runtime. Supplied explicitly to {@link AgentHandle.run} —
 * render belongs to the caller, not the handle. It is only ever invoked
 * for a non-null request, so it never has to model the "no new input"
 * case (see {@link AgentHandle.run}).
 *
 * The handle also passes the per-turn {@link AgentTurnState} it owns as
 * the second argument, so a *stateful* render can vary its output by
 * session position without reading driver-owned state directly (the
 * driver supplies the state; the render interprets it). A stateless
 * render simply ignores it.
 *
 * `TRequest` is the host request shape (the L1↔L2 request contract, kept
 * as a type parameter so this package stays host-agnostic). `TRendered`
 * is the backend-native render output (pi-ai `Message[]` for the built-in
 * path, ACP prompt blocks for the external path). `TState` is the
 * driver-supplied turn state, defaulting to the canonical
 * {@link AgentTurnState}.
 */
export type RenderFn<TRequest, TRendered, TState = AgentTurnState> = (
  request: TRequest,
  state: TState,
) => TRendered | Promise<TRendered>;

/**
 * The in-process handle to one live agent workload — the ACP *client
 * role* (stateful, bidirectional, capability-negotiated), not an HTTP
 * client.
 *
 * Lifecycle (§3.2 / M2.6): a handle is either a **Job** (its life *is*
 * one run — `run()` once, then terminal, essentially a function call) or
 * a **Deployment** (a long-lived session that hosts *many* runs plus
 * cross-turn `control`, notifications, liveness, and explicit `close`).
 * A single **run/turn** is the unit both share; `run()` is that unit.
 * A Deployment is the base run-producer + a session layer; a Job is the
 * degenerate one-shot. L2 (`AgentRuntime`) holds Deployment handles live
 * across turns keyed by `threadId`; a Job never enters that registry.
 *
 * Its facets:
 *
 *   - `run(request, render, ctx)` — the data plane for one turn. Merges
 *     "submit this turn's input" with "stream this turn's output": renders
 *     the (non-null) request at the last moment (render belongs to the
 *     caller, not the handle), feeds it to the backing runtime, and yields
 *     the per-turn `AgentStreamEvent`s — returning this turn's transcript
 *     delta ({@link TResult}) as the generator's return value. `ctx` is the
 *     host-supplied per-turn context (see {@link TTurnCtx}). Called once
 *     for a Job; once per turn on a long-lived Deployment.
 *   - `control(msg)` — the control plane: host→agent operations over the
 *     `@agenetes/protocol` `ControlMsg` vocabulary, gated by
 *     {@link AgentHandle.capabilities}. Usable out-of-turn on a Deployment.
 *   - `close()` — release this workload (teardown the session / drop the
 *     backing connection). A Job's `close` is a no-op (its run already
 *     ended it); a Deployment tears down its long-lived session.
 *   - `capabilities` — the advertised capability descriptor.
 *
 * The type parameters keep the framework host-agnostic: `TRequest` is the
 * host request shape, `TRendered` the backend-native render output,
 * `TResult` the transcript-delta the generator returns (the host binds it
 * to e.g. pi-ai `Message[]`), `TEvent` the (protocol-assignable) event
 * union it yields, and `TTurnCtx` the host's per-turn context bundle.
 */
export interface AgentHandle<
  TRequest = unknown,
  TRendered = unknown,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
> {
  /**
   * Run one turn: render + submit this turn's input, then stream its
   * output. When `request` is non-null it is rendered via `render` at the
   * last moment and fed to the backing runtime (built-in: `agent.prompt`;
   * external: `client.prompt`); the generator then yields the turn's
   * `AgentStreamEvent`s and returns the turn's transcript delta (the
   * messages to persist) as its return value.
   *
   * `request` MAY be `null`, meaning "no new input this turn". The
   * interface fixes only that null is *accepted*; its meaning is entirely
   * driver-defined and carries NO protocol-level contract. A driver is
   * free to treat it as "resume the pre-loaded transcript" (the built-in
   * path calls `agent.continue()`), or to reject it (a driver that always
   * needs fresh input may emit an `error` event or no-op). When `request`
   * is null, `render` is never invoked.
   *
   * `ctx` carries the host's per-turn context (the mutable overlay, the
   * turn's abort signal, the request-scoped logger, per-turn hooks, and —
   * for a Deployment whose backing object is re-resolved each turn — the
   * live backing object). It is a host-bound opaque bundle so the exact
   * turn-vs-driver split can be refined without touching this seam.
   *
   * The yield type is a `TEvent` generic (defaulting to the wire-level
   * `@agenetes/protocol` `AgentStreamEvent`) so the host can bind it to a
   * host-extended event union — e.g. one carrying extra tool metadata, or
   * excluding transport-synthesized frames like `meta`/`end`. `TEvent` is
   * constrained to remain protocol-assignable, keeping the wire contract.
   */
  run(
    request: TRequest | null,
    render: RenderFn<TRequest, TRendered>,
    ctx: TTurnCtx,
  ): AsyncGenerator<TEvent, TResult>;

  /**
   * Send a host→agent control operation. Resolves to a `ControlAck`;
   * unsupported operations (not in `capabilities.control`) resolve to
   * `{ ok: false, code: 'unsupported' }` rather than throwing. On a
   * long-lived Deployment this is usable out-of-turn (between runs); an
   * op that has no live session to act on resolves to a failure ack.
   */
  control(msg: ControlMsg): Promise<ControlAck>;

  /**
   * Release this workload. For a long-lived Deployment this tears down
   * the session (drops the backing connection); for a one-shot Job it is
   * a no-op (the single `run` already ended its life). Idempotent.
   */
  close(): void;

  /**
   * The **up-report seam** (README I9.7): subscribe to this handle's
   * durable-state changes. The handle is the SOLE folder — it folds its
   * driver-native meta into a single full {@link AgentStateSnapshot} and
   * pushes the *whole current snapshot* to `listener` on every change (a
   * full snapshot, never a per-field delta, so the subscriber stays
   * stateless and replaces wholesale). Returns an unsubscribe function.
   *
   * The instance registers ONE listener per Deployment handle at `create`
   * (push, not a per-handle polling loop) to persist the snapshot and
   * re-emit it on `notifications(threadId)`; it calls the returned
   * unsubscribe at `close`.
   *
   * Optional: a handle with no out-of-turn state — a Job, or a driver
   * (e.g. the built-in) that reports no meta — simply omits it, and its
   * `notifications` stream stays empty. In-turn meta still rides `run`'s
   * event stream for the live UI regardless; `onState` is the persistence
   * / out-of-turn channel, so the two never double-fold (the fold happens
   * once, here).
   */
  onState?(listener: (snapshot: AgentStateSnapshot) => void): () => void;

  /** The capability descriptor this handle advertises. */
  readonly capabilities: AgentCapabilities;
}
