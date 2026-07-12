// The workload-realization and live-handle lifecycle seams (README I2).
// Agenetes dispatches a serializable workload spec to a registered
// `AgentDriver`; the driver realizes it as an `AgentHandle`. Host-owned
// dependencies enter standard drivers through their mount-time factory
// ports, never as per-create backing objects.

import type { AgentHandle } from './handle.js';
import type { AgentCreateContext } from './realization.js';
import type { AgentStreamEvent, AgentSubmission } from '@agenetes/protocol';

/**
 * A registered driver realizes a target create input into an
 * {@link AgentHandle}. The create context carries any source thread's
 * durable record and folded turns plus instance-level recovery policy.
 * Kept fully generic so this package never names a host spec type.
 */
export interface AgentDriver<
  TInput = unknown,
  TSubmission extends AgentSubmission = AgentSubmission,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
> {
  /**
   * Produce a handle for one target workload. The context is always
   * provided; `durableInput` is absent for a fresh create.
   */
  create(
    input: TInput,
    context: AgentCreateContext<TInput>,
  ): AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>;
}

/**
 * The driver registry + the live-handle lifecycle owner — L2's dispatch
 * table (the generalisation of the hard-coded
 * `binding.kind === 'external' ? runAcpAgent : runAgent` fork) grown into
 * a lifecycle owner that holds long-lived Deployment handles keyed by
 * `threadId` (§3.6.1 / M2.6).
 *
 * Two orthogonal concerns:
 *   - *Driver dispatch* (`register` / `resolve` / `has` / `kinds`): map a
 *     driver *kind* to the object that knows how to `create` its handles.
 *   - *Handle lifecycle* (`get` / `getOrCreate` / `close`): hold the live
 *     Deployment handle for a `threadId`, generalising today's
 *     `ensureAcpSession` (get-or-create-by-threadId). This is imperative
 *     lifecycle ownership of one named workload per `threadId` — no queue,
 *     no placement, no replicas, and (by choosing `create` over a
 *     declarative `apply`) no desired-state reconcile loop. It is *not* a
 *     scheduler and *not* a reconciler.
 *
 * A one-shot Job never enters the lifecycle registry: its handle lives
 * only for its single `run`, so callers `resolve` its driver and `create`
 * + `run` a fresh handle directly, and `get(threadId)` is always
 * `undefined` for it.
 */
export interface AgentRuntime {
  /**
   * Register (inject) a driver under the dispatch `kind`. The `kind` is
   * supplied by the caller (never read off the driver — a driver carries
   * no `kind`); re-registering a `kind` replaces it.
   */
  register(kind: string, driver: AgentDriver): void;

  /**
   * Look up a driver by kind. The caller knows the concrete driver shape
   * for its kind and binds the type parameters accordingly.
   */
  resolve<
    TInput = unknown,
    TSubmission extends AgentSubmission = AgentSubmission,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    kind: string,
  ): AgentDriver<TInput, TSubmission, TResult, TEvent, TTurnCtx> | undefined;

  /** Whether a driver is registered for `kind`. */
  has(kind: string): boolean;

  /** The registered driver kinds, in registration order. */
  readonly kinds: readonly string[];

  /**
   * Pure lookup of the live handle bound to `threadId` — **no spec**,
   * never creates. Returns `undefined` when no handle is live (e.g. a
   * one-shot Job, or a Deployment not yet created / already closed).
   *
   * This retires the wart where control routes drag `{profileId,
   * canvasId, cwd}` around merely to *find* a session: they become
   * `get(threadId)?.control(...)`, and a missing session is a
   * precondition failure (do not lazily spawn a session just to, e.g.,
   * set a mode). The caller supplies the concrete generics for the kind
   * it knows lives under `threadId`.
   */
  get<
    TSubmission extends AgentSubmission = AgentSubmission,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    threadId: string,
  ): AgentHandle<TSubmission, TResult, TEvent, TTurnCtx> | undefined;

  /**
   * Get or create the live handle for `threadId`. If one is already live
   * it is returned as-is; otherwise `createHandle` constructs and registers
   * it. `createHandle` closes over the workload spec, which is used only at
   * construction;
   * this deliberately **does not reconcile spec drift** (changing the spec
   * is an explicit `close()` + `create()` the caller decides, not a hidden
   * reconcile). This matches `ensureAcpSession`'s reuse-ignores-spec
   * behaviour.
   */
  getOrCreate<
    TSubmission extends AgentSubmission = AgentSubmission,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    threadId: string,
    createHandle: () => AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>,
  ): AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>;

  /**
   * Close and evict the live handle for `threadId` (calls `handle.close()`
   * then forgets it). No-op when nothing is live. Idempotent.
   */
  close(threadId: string): void;
}

/** Create an empty {@link AgentRuntime} (a `Map`-backed dispatch table). */
export function createAgentRuntime(): AgentRuntime {
  const drivers = new Map<string, AgentDriver>();
  // The live-handle lifecycle registry: one long-lived Deployment handle
  // per `threadId`. Jobs never enter here.
  const handles = new Map<string, AgentHandle>();
  return {
    register(kind: string, driver: AgentDriver): void {
      drivers.set(kind, driver);
    },
    resolve<
      TInput,
      TSubmission extends AgentSubmission,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(kind: string) {
      // The registry is heterogeneous (each kind has its own input/result
      // shapes); the caller supplies the concrete generics for its kind.
      return drivers.get(kind) as
        | AgentDriver<TInput, TSubmission, TResult, TEvent, TTurnCtx>
        | undefined;
    },
    has(kind: string): boolean {
      return drivers.has(kind);
    },
    get kinds(): readonly string[] {
      return [...drivers.keys()];
    },
    get<
      TSubmission extends AgentSubmission,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(threadId: string) {
      // Heterogeneous like `resolve`: the caller binds the generics for
      // the kind it knows lives under `threadId`.
      return handles.get(threadId) as
        | AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>
        | undefined;
    },
    getOrCreate<
      TSubmission extends AgentSubmission,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(
      threadId: string,
      createHandle: () => AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>,
    ) {
      const existing = handles.get(threadId);
      if (existing) {
        return existing as AgentHandle<TSubmission, TResult, TEvent, TTurnCtx>;
      }
      const created = createHandle();
      handles.set(threadId, created as AgentHandle);
      return created;
    },
    close(threadId: string): void {
      const handle = handles.get(threadId);
      if (!handle) return;
      handle.close();
      handles.delete(threadId);
    },
  };
}
