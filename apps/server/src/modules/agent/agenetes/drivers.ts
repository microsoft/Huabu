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
import { Agent } from '@earendil-works/pi-agent-core';

import { ensureApiKey, getLLMModel } from '../llm.js';
import { getSessionReadSet } from '../session-read-set.js';
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
import { buildToolsForScope, type ToolScope } from '../tools/index.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { Namespace, WorkloadType } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';
import type { NodeOrigin } from '@sediment/shared';

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
 * The serializable built-in `WorkloadSpec` (I8.5 / I9.6) — a Job. It is a
 * pure-data projection the built-in factory constructs a fresh backing
 * `Agent` from each turn: NO live `Agent` / no live `Map` rides it (the
 * one live value the old `create({ agent })` path carried — the tool
 * `readSet` — is resolved *inside* the factory closure via
 * {@link getSessionReadSet}, never on the seam).
 *
 * A Job is minted fresh every turn, so the spec is the honest, complete
 * description of that turn's unit of work: the prior transcript rides
 * `messages` (baked at create-time by L1's multi-turn assembly, I9.3),
 * not `request`.
 */
export interface BuiltinWorkloadSpec {
  /** The driver route (I5) — the built-in's contract kind (`internal`). */
  readonly kind: string;
  /** The lifecycle axis (I3.2) — always `'Job'` for the built-in. */
  readonly workloadType: WorkloadType;
  /** Conversation thread identity (I4.2). */
  readonly threadId: string;
  /** The namespace the durable record is persisted under (I4.1). */
  readonly namespace: Namespace;
  /** System prompt for this turn's backing agent. */
  readonly systemPrompt?: string;
  /** Tool surface + scope-specific wiring (`buildToolsForScope`). */
  readonly scope: ToolScope;
  /** Current canvas id, implicit context for canvas-aware tools. */
  readonly canvasId?: string;
  /** `NodeOrigin` stamp forwarded to `canvas_commands`. */
  readonly origin?: NodeOrigin;
  /** Prior transcript the agent runs over (baked by L1, read-only input). */
  readonly messages: Message[];
  /** Soft cap on agent turns (LLM call + tool batch). */
  readonly maxIterations?: number;
}

/**
 * The I9.5 driver factory for the in-process built-in ("internal") driver
 * — a Job (cancel-only control). Unlike the ACP factory (which ships in a
 * cross-package subtree and takes its transport via `factoryArgs`), this
 * is an **L1 artifact**: it lives in `apps/server`, so it closes over the
 * host singletons directly (`getLLMModel` / `ensureApiKey` /
 * `buildToolsForScope` / `getSessionReadSet`) and needs no `factoryArgs`.
 * `create(spec)` builds a fresh backing `Agent` over the baked transcript
 * and wraps it in a {@link BuiltinAgentHandle}.
 */
export const builtinDriverFactory = (): AgentDriver<
  BuiltinWorkloadSpec,
  AgentRequest,
  BuiltinRendered,
  Message[],
  InStreamEvent,
  BuiltinTurnCtx
> => ({
  // No `kind`: dispatch is external (M5.09) — the mount
  // `.register(INTERNAL_DRIVER_KIND, BUILTIN_FACTORY_NAME)` fixes it.
  capabilities: BUILTIN_CAPABILITIES,
  create(spec: BuiltinWorkloadSpec): BuiltinAgentHandle {
    const tools = buildToolsForScope(spec.scope, {
      canvasId: spec.canvasId,
      origin: spec.origin,
      threadId: spec.threadId,
      // Session-scoped read-set (per conversation thread), resolved INSIDE
      // this L1 closure — a live Map that never crosses the L1↔L2 seam.
      readSet: getSessionReadSet(spec.threadId),
    });
    ensureApiKey();
    const agent = new Agent({
      initialState: {
        systemPrompt: spec.systemPrompt,
        model: getLLMModel(),
        tools,
        // Prior transcript baked by L1; this turn's rendered rows are
        // appended by the handle's `run` (`agent.prompt`), leaving these
        // read-only input whose output travels out via the run's return.
        messages: spec.messages,
      },
      convertToLlm: (msgs) => msgs as Message[],
      // Invoked before every LLM call (incl. across long tool batches) so
      // short-lived OAuth bearers can refresh — reuse the host resolver.
      getApiKey: () => ensureApiKey(),
      // Independent tool calls in a batch run concurrently; a batch with a
      // canvas write falls back to serial via the tool's `executionMode`.
      toolExecution: 'parallel',
    });
    return new BuiltinAgentHandle(agent);
  },
});

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
