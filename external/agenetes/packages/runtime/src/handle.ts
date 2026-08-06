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
//     It must not import `@huabu/shared`, pi-ai / pi-agent-core, the
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
  AgentSubmission,
  AgentStateSnapshot,
  AgentStreamEvent,
  ControlAck,
  ControlMsg,
} from '@agenetes/protocol';

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
 *   - `run(submission, ctx)` — the data plane for one turn. The submission
 *     carries durable host source data plus optional canonical inputs. The
 *     driver resolves and lowers those inputs into its backend-native form.
 *   - `control(msg)` — the control plane: host→agent operations over the
 *     `@agenetes/protocol` `ControlMsg` vocabulary, gated by
 *     {@link AgentHandle.capabilities}. Usable out-of-turn on a Deployment.
 *   - `close()` — release this workload (teardown the session / drop the
 *     backing connection). A Job's `close` is a no-op (its run already
 *     ended it); a Deployment tears down its long-lived session.
 *   - `capabilities` — the advertised capability descriptor.
 *
 * The type parameters keep the framework host-agnostic: `TSubmission` is
 * the host's source specialization, `TResult` is the run return value,
 * `TEvent` is the yielded protocol event union, and `TTurnCtx` is the
 * host's per-turn context bundle.
 */
export interface AgentHandle<
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
  TDriverState = unknown,
> {
  /**
   * Run one turn by resolving the submission's canonical inputs, lowering
   * them to the backend, and streaming the resulting events.
   *
   * `request` MAY be `null`, meaning "no new input this turn". The
   * interface fixes only that null is *accepted*; its meaning is entirely
   * driver-defined and carries NO protocol-level contract. A driver is
   * free to treat it as "resume the pre-loaded transcript" (the built-in
   * path calls `agent.continue()`), or to reject it (a driver that always
   * needs fresh input may emit an `error` event or no-op).
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
    submission: TSubmission | null,
    ctx: TTurnCtx,
  ): AsyncGenerator<TEvent, TResult>;

  /**
   * Send a host→agent control operation. Resolves to a `ControlAck`;
   * unsupported operations (not in
   * `capabilities.supportedControlMessages`) resolve to
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
  onState?(
    listener: (snapshot: AgentStateSnapshot<TDriverState>) => void,
  ): () => void;

  /** The capability descriptor this handle advertises. */
  readonly capabilities: AgentCapabilities;
}
