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
  /** Stable driver-kind key (e.g. `'builtin'`, `'acp'`) — the dispatch key. */
  readonly kind: string;
  /** The capability descriptor every handle from this driver advertises. */
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
> extends AgentDriverInfo {
  /** Produce a handle for one workload from the host-injected `input`. */
  create(input: TInput): AgentHandle<TRequest, TRendered, TResult, TEvent>;
}

/**
 * The driver registry — L2's dispatch table, the generalisation of the
 * hard-coded `binding.kind === 'external' ? runAcpAgent : runAgent` fork.
 * L1 `register`s drivers into it; L2 `resolve`s by kind and calls
 * `create`.
 */
export interface AgentRuntime {
  /** Register (inject) a driver. Re-registering a kind replaces it. */
  register(driver: AgentDriver): void;

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
  >(
    kind: string,
  ): AgentDriver<TInput, TRequest, TRendered, TResult, TEvent> | undefined;

  /** Whether a driver is registered for `kind`. */
  has(kind: string): boolean;

  /** The registered driver kinds, in registration order. */
  readonly kinds: readonly string[];
}

/** Create an empty {@link AgentRuntime} (a `Map`-backed dispatch table). */
export function createAgentRuntime(): AgentRuntime {
  const drivers = new Map<string, AgentDriver>();
  return {
    register(driver: AgentDriver): void {
      drivers.set(driver.kind, driver);
    },
    resolve<
      TInput,
      TRequest,
      TRendered,
      TResult,
      TEvent extends AgentStreamEvent,
    >(kind: string) {
      // The registry is heterogeneous (each kind has its own input/result
      // shapes); the caller supplies the concrete generics for its kind.
      return drivers.get(kind) as
        | AgentDriver<TInput, TRequest, TRendered, TResult, TEvent>
        | undefined;
    },
    has(kind: string): boolean {
      return drivers.has(kind);
    },
    get kinds(): readonly string[] {
      return [...drivers.keys()];
    },
  };
}
