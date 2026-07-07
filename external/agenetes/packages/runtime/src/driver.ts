// The driver register / injection seam (§3.6.1 / §3.6.2).
//
// `AgentDriver` is how L1 teaches L2 to run one *kind* of agent: given a
// host-injected backing object (a pi-agent-core `Agent`, an ACP session
// entry, …), produce an {@link AgentHandle}. This is the pragmatic,
// object-injection stand-in for the clean §3.6 `driver.create(spec)`
// factory: the host still constructs the backing runtime instance (it
// owns the host singletons + canvas coupling), and hands it in via
// `create(input)`. The clean factory (spec in, no host objects) lands once
// M4 (canvas DI) / M5 (package boundary) make those resources injectable.
//
// The K8s/CRI analogy the design leans on: `AgentRuntime` is the runtime
// framework, `AgentDriver`s are the runtimes it dispatches to. Standard
// drivers (e.g. ACP) are destined to ship *inside* this package; custom,
// business-coupled drivers (the canvas built-in agents) are always
// registered by L1. Today both are registered as objects.

import type { AgentHandle } from './handle.js';
import type { AgentCapabilities, AgentStreamEvent } from '@agenetes/protocol';

/**
 * The generics-free driver metadata the registry can store and enumerate
 * without knowing a driver's concrete input/request/result shapes.
 */
export interface AgentDriverInfo {
  /**
   * The capability descriptor every handle from this driver advertises.
   *
   * A driver carries **no `kind`**: dispatch is decided entirely by the
   * caller that registers it (`register(kind, driver)`) — the contract
   * `kind` is external to the factory, not a property it advertises.
   */
  readonly capabilities: AgentCapabilities;
}

/**
 * A registered driver: wraps a host-injected backing object into an
 * {@link AgentHandle}. `TInput` is the host-shaped construction bundle
 * (backing runtime object + per-invocation options); the host driver
 * forwards it to its concrete handle constructor. Kept fully generic so
 * this package never names a host type.
 */
export interface AgentDriver<
  TInput = unknown,
  TRequest = unknown,
  TRendered = unknown,
  TResult = unknown,
  TEvent extends AgentStreamEvent = AgentStreamEvent,
  TTurnCtx = unknown,
> extends AgentDriverInfo {
  /** Produce a handle for one workload from the host-injected `input`. */
  create(
    input: TInput,
  ): AgentHandle<TRequest, TRendered, TResult, TEvent, TTurnCtx>;
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
 *   - *Handle lifecycle* (`get` / `create` / `close`): hold the live
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
    TRequest = unknown,
    TRendered = unknown,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    kind: string,
  ):
    | AgentDriver<TInput, TRequest, TRendered, TResult, TEvent, TTurnCtx>
    | undefined;

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
    TRequest = unknown,
    TRendered = unknown,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    threadId: string,
  ): AgentHandle<TRequest, TRendered, TResult, TEvent, TTurnCtx> | undefined;

  /**
   * Get-or-create the live handle for `threadId`. If one is already live
   * it is returned as-is (collapsing the concurrent-first-call race);
   * otherwise `factory` constructs it and it is registered. The `factory`
   * closes over the workload spec — spec is used **only at construction**;
   * this deliberately **does not reconcile spec drift** (changing the spec
   * is an explicit `close()` + `create()` the caller decides, not a hidden
   * reconcile). This matches `ensureAcpSession`'s reuse-ignores-spec
   * behaviour. (The clean `create(threadId, spec)` factory — spec in, no
   * host objects — lands once M4/M5 make the ACP driver's host resources
   * injectable; today the host-supplied `factory` is the object-injection
   * stand-in.)
   */
  create<
    TRequest = unknown,
    TRendered = unknown,
    TResult = unknown,
    TEvent extends AgentStreamEvent = AgentStreamEvent,
    TTurnCtx = unknown,
  >(
    threadId: string,
    factory: () => AgentHandle<TRequest, TRendered, TResult, TEvent, TTurnCtx>,
  ): AgentHandle<TRequest, TRendered, TResult, TEvent, TTurnCtx>;

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
      TRequest,
      TRendered,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(kind: string) {
      // The registry is heterogeneous (each kind has its own input/result
      // shapes); the caller supplies the concrete generics for its kind.
      return drivers.get(kind) as
        | AgentDriver<TInput, TRequest, TRendered, TResult, TEvent, TTurnCtx>
        | undefined;
    },
    has(kind: string): boolean {
      return drivers.has(kind);
    },
    get kinds(): readonly string[] {
      return [...drivers.keys()];
    },
    get<
      TRequest,
      TRendered,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(threadId: string) {
      // Heterogeneous like `resolve`: the caller binds the generics for
      // the kind it knows lives under `threadId`.
      return handles.get(threadId) as
        | AgentHandle<TRequest, TRendered, TResult, TEvent, TTurnCtx>
        | undefined;
    },
    create<
      TRequest,
      TRendered,
      TResult,
      TEvent extends AgentStreamEvent,
      TTurnCtx,
    >(
      threadId: string,
      factory: () => AgentHandle<
        TRequest,
        TRendered,
        TResult,
        TEvent,
        TTurnCtx
      >,
    ) {
      const existing = handles.get(threadId);
      if (existing) {
        return existing as AgentHandle<
          TRequest,
          TRendered,
          TResult,
          TEvent,
          TTurnCtx
        >;
      }
      const created = factory();
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
