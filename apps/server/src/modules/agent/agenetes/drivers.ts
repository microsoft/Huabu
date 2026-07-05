/**
 * Host-side driver registration — where L1 injects its two agent drivers
 * into the L2 {@link AgentRuntime} as objects.
 *
 * This is the pragmatic, object-injection form of the §3.6 driver
 * registry: the host still constructs each backing runtime instance (a
 * pi-agent-core `Agent`, an ACP session `entry`) because it owns the host
 * singletons + canvas coupling, and each driver's `create` merely wraps
 * that injected object in the matching handle. The registry then
 * generalises the old hard-coded `binding.kind === 'external' ? … : …`
 * fork: callers `resolve(kind)` and `create(input)`.
 *
 * Neither driver is "built in" to `@agenetes/runtime` yet: the ACP driver
 * (a *standard* driver) still reaches host translator/store/transport
 * modules, and the built-in driver is deliberately canvas-coupled and
 * L1-owned. Both are therefore registered here from L1. See
 * docs/proposals/layered-architecture.md §3.6 / §7.
 */

import {
  ACP_CAPABILITIES,
  AcpAgentHandle,
  type AcpTurnCtx,
  type PreparedAcpPrompt,
} from '@agenetes/acp-driver';

import {
  BUILTIN_CAPABILITIES,
  BuiltinAgentHandle,
  type BuiltinTurnCtx,
  type BuiltinRendered,
} from './builtin-handle.js';
import {
  createAgentRuntime,
  type AgentDriver,
  type AgentHandle,
  type AgentRequest,
  type AgentRuntime,
  type InStreamEvent,
} from './handle.js';

import type { Agent } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

/** Dispatch key for the in-process pi-agent-core (built-in) driver. */
export const BUILTIN_DRIVER_KIND = 'builtin';
/** Dispatch key for the external ACP (agentlet) driver. */
export const ACP_DRIVER_KIND = 'acp';

/**
 * The host-injected construction bundle for the built-in driver. A Job's
 * backing `Agent` is a fresh instance per invocation, so it is the whole
 * construction input; per-turn context flows through `run(...)`'s
 * {@link BuiltinTurnCtx}.
 */
export interface BuiltinDriverInput {
  /** The pi-agent-core runtime object, built over this turn's history. */
  agent: Agent;
}

/**
 * The host-injected construction bundle for the ACP driver. A Deployment
 * handle is long-lived and holds only its `threadId`; the live session
 * entry + per-turn context arrive on each `run(...)`'s {@link AcpTurnCtx}.
 */
export interface AcpDriverInput {
  /** The L1-minted addressable id this Deployment is keyed by. */
  threadId: string;
}

export type BuiltinAgentDriver = AgentDriver<
  BuiltinDriverInput,
  AgentRequest,
  BuiltinRendered,
  Message[],
  InStreamEvent,
  BuiltinTurnCtx
>;

export type AcpAgentDriver = AgentDriver<
  AcpDriverInput,
  AgentRequest,
  PreparedAcpPrompt,
  Message[],
  InStreamEvent,
  AcpTurnCtx
>;

/** The concrete long-lived ACP (Deployment) handle type. */
export type AcpHandle = AgentHandle<PreparedAcpPrompt, AcpTurnCtx>;

/** The in-process built-in driver (a Job: cancel-only control). */
export const builtinAgentDriver: BuiltinAgentDriver = {
  kind: BUILTIN_DRIVER_KIND,
  capabilities: BUILTIN_CAPABILITIES,
  create: ({ agent }) => new BuiltinAgentHandle(agent),
};

/** The external ACP driver (a Deployment: full control + session-load). */
export const acpAgentDriver: AcpAgentDriver = {
  kind: ACP_DRIVER_KIND,
  capabilities: ACP_CAPABILITIES,
  create: ({ threadId }) => new AcpAgentHandle<AgentRequest>(threadId),
};

/**
 * The process-wide runtime with both drivers registered (injected by L1
 * at module load). Shells `resolve` their driver by kind and `create` a
 * handle from the backing object they built.
 */
export const agentRuntime: AgentRuntime = createAgentRuntime();
agentRuntime.register(builtinAgentDriver);
agentRuntime.register(acpAgentDriver);

/**
 * Resolve the built-in driver, throwing if it was never registered (a
 * programming error — it is registered at module load above).
 */
export function getBuiltinDriver(): BuiltinAgentDriver {
  const driver = agentRuntime.resolve<
    BuiltinDriverInput,
    AgentRequest,
    BuiltinRendered,
    Message[],
    InStreamEvent,
    BuiltinTurnCtx
  >(BUILTIN_DRIVER_KIND);
  if (!driver) {
    throw new Error(
      `no agent driver registered for kind '${BUILTIN_DRIVER_KIND}'`,
    );
  }
  return driver;
}

/** Resolve the ACP driver, throwing if it was never registered. */
export function getAcpDriver(): AcpAgentDriver {
  const driver = agentRuntime.resolve<
    AcpDriverInput,
    AgentRequest,
    PreparedAcpPrompt,
    Message[],
    InStreamEvent,
    AcpTurnCtx
  >(ACP_DRIVER_KIND);
  if (!driver) {
    throw new Error(`no agent driver registered for kind '${ACP_DRIVER_KIND}'`);
  }
  return driver;
}

/**
 * Get-or-create the long-lived ACP (Deployment) handle for `threadId`.
 * The handle is held live in the runtime across turns (keyed by
 * `threadId`), so `control()` / `close()` are addressable out-of-turn.
 * The construction `factory` is object-injection (the clean
 * `create(threadId, spec)` factory lands with M4/M5); it captures nothing
 * per-turn (the live session entry flows through each `run(...)`), so
 * reuse-ignores-spec holds trivially.
 */
export function acquireAcpHandle(threadId: string): AcpHandle {
  return agentRuntime.create<
    AgentRequest,
    PreparedAcpPrompt,
    Message[],
    InStreamEvent,
    AcpTurnCtx
  >(threadId, () => getAcpDriver().create({ threadId }));
}
