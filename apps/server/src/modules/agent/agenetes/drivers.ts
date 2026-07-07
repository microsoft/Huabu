/**
 * Host-side driver registration — where L1 mounts the L2 {@link Agenetes}
 * instance (the object the rest of `apps/server` faces) and keeps the one
 * canvas-coupled driver it must still own itself.
 *
 * The standard ACP ("external") driver now ships inside
 * `@agenetes/acp-driver` and self-resolves its own session per turn, so it
 * is registered into the mounted instance through the I9.5
 * driver-factory-dictionary builder ({@link mountAgenetes}). The built-in
 * pi-agent-core driver is deliberately canvas-coupled — its `create`
 * needs a per-turn, history-built `Agent`, so it cannot be constructed
 * from a serializable spec alone — and therefore stays a host-owned Job
 * driver, invoked directly (never through the instance). See
 * docs/proposals/layered-architecture.md §3.6 / §7 (M5).
 */

import {
  acpDriverFactory,
  type AcpCreateSpec,
  type AcpTurnCtx,
  type PreparedAcpPrompt,
} from '@agenetes/acp-driver';
import { mountAgenetes } from '@agenetes/agenetes';

import {
  BUILTIN_CAPABILITIES,
  BuiltinAgentHandle,
  type BuiltinTurnCtx,
  type BuiltinRendered,
} from './builtin-handle.js';
import {
  type AgentDriver,
  type AgentHandle,
  type AgentRequest,
  type InStreamEvent,
} from './handle.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { WorkloadType } from '@agenetes/protocol';
import type { Agent } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';

/**
 * Dispatch key reserved for the in-process pi-agent-core (built-in) driver.
 * The built-in is currently a plain const (not registry-dispatched), so this
 * is not wired at `register()` yet — it becomes the `.register('internal', …)`
 * contract kind when the built-in is folded into the instance (M5.1).
 */
export const BUILTIN_DRIVER_KIND = 'builtin';

/**
 * The external ACP driver's dispatch `kind` — the I5 *contract* kind L1
 * injects at `register()` (I5.1 alias / I9.5), aligned with the wire
 * `agentBindingSchema` `kind: 'external'`. It is L1's to choose at mount,
 * so it lives here (not in the driver package): the driver carries no `kind`
 * of its own (dispatch is external, M5.09), and this `driverName` is the sole
 * dispatch key the builder registers it under. The factory-dictionary name
 * (`acp`, {@link ACP_FACTORY_NAME}) is its *implementation* identity.
 */
export const EXTERNAL_DRIVER_KIND = 'external';
export type { AcpCreateSpec };

/** The factory-dictionary name (impl identity) for the ACP driver (I5.1). */
const ACP_FACTORY_NAME = 'acp';

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

export type BuiltinAgentDriver = AgentDriver<
  BuiltinDriverInput,
  AgentRequest,
  BuiltinRendered,
  Message[],
  InStreamEvent,
  BuiltinTurnCtx
>;

/**
 * The host `WorkloadSpec` the ACP driver is created from — the baked
 * {@link AcpCreateSpec} plus the dispatch `kind` the instance routes on
 * (I5) and the lifecycle `workloadType` (I3.2). An ACP session is a
 * long-lived, stateful connection, so it is always a `Deployment`. L1
 * mints it per thread and hands it to {@link agenetes.create}; the handle
 * bakes it and self-resolves its live session per turn.
 */
export type AcpWorkloadSpec = AcpCreateSpec & {
  readonly kind: string;
  readonly workloadType: WorkloadType;
};

/** The concrete long-lived ACP (Deployment) handle type. */
export type AcpHandle = AgentHandle<PreparedAcpPrompt, AcpTurnCtx>;

/**
 * The in-process built-in driver (a Job: cancel-only control). Held as a
 * plain const — a Job never enters a live-handle table, so it needs no
 * runtime registry; the host constructs its handle directly per turn.
 */
export const builtinAgentDriver: BuiltinAgentDriver = {
  capabilities: BUILTIN_CAPABILITIES,
  create: ({ agent }) => new BuiltinAgentHandle(agent),
};

/**
 * The mounted Agenetes instance (I9) — the single L2 object L1 faces for
 * the ACP path. It owns the ACP driver (registered via the I9.5 builder),
 * the global live-handle table (`create` / `get` / `close`), and the
 * per-namespace durable thread table (`record` / `records`). The built-in
 * driver is intentionally NOT registered here (see {@link
 * builtinAgentDriver}).
 */
export const agenetes: Agenetes<AcpWorkloadSpec, AcpHandle> = mountAgenetes()
  .addFactory(ACP_FACTORY_NAME, acpDriverFactory<AgentRequest>)
  .register(EXTERNAL_DRIVER_KIND, ACP_FACTORY_NAME)
  .build<AcpWorkloadSpec, AcpHandle>();

/**
 * Resolve the built-in Job driver. It is a plain const (not registry
 * dispatch), so this is a trivial accessor kept for a stable call site.
 */
export function getBuiltinDriver(): BuiltinAgentDriver {
  return builtinAgentDriver;
}
