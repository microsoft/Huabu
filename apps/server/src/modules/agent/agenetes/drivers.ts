/**
 * Host-side driver registration — where L1 mounts the L2 {@link Agenetes}
 * instance (the object the rest of `apps/server` faces) and keeps the one
 * Huabu-specific ports it supplies to standard drivers.
 *
 * The standard ACP ("external") driver now ships inside
 * `@agenetes/acp-driver` and self-resolves its own session per turn, so it
 * is registered into the mounted instance through the I9.5 builder
 * ({@link mountAgenetes}). The built-in path uses the standard pi driver;
 * L1 owns only its model, account, and tool ports plus spec compilation.
 */

import { type AcpCreateSpec, type AcpTurnCtx } from '@agenetes/acp-driver';
import {
  mountAgenetes,
  FileThreadStore,
  FileEventLogStore,
  FileTurnStore,
} from '@agenetes/agenetes';
import {
  type AgentProfileWorkloadSpec,
  type LegacyAgentProfileWorkloadSpec,
} from '@agenetes/agent-team';
import { getAgentTeamRegistry } from '@agenetes/agentlet-host';
import { type PiTurnCtx, type PiWorkloadSpec } from '@agenetes/pi-driver';

import { type AgentHandle } from './handle.js';
import { huabuPiDriverPorts } from './pi-driver.js';
import { getExternalAgentRuntimeConfig } from '../acp/runtime-config.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { WorkloadType } from '@agenetes/protocol';
import type { Message } from '@earendil-works/pi-ai';

/**
 * The built-in driver's dispatch `kind` — the I5 *contract* kind L1 injects
 * through `AgenetesBuilder.register(...)`, the `internal` counterpart to
 * the ACP driver's `external` ({@link EXTERNAL_DRIVER_KIND}). It rides
 * `WorkloadSpec.kind`.
 */
export const INTERNAL_DRIVER_KIND = 'internal';

/**
 * The external ACP driver's dispatch `kind` — the I5 *contract* kind L1
 * supplies through `AgenetesBuilder.register(...)`, aligned with the wire
 * `agentBindingSchema` `kind: 'external'`. It lives here because the driver
 * carries no `kind` of its own.
 */
export const EXTERNAL_DRIVER_KIND = 'external';
export type { AcpCreateSpec };

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

export type ProfileWorkloadSpec = AgentProfileWorkloadSpec & {
  readonly kind: string;
  readonly workloadType: WorkloadType;
};

export type LegacyProfileWorkloadSpec = LegacyAgentProfileWorkloadSpec & {
  readonly kind: string;
  readonly workloadType: WorkloadType;
};

/** The concrete long-lived ACP (Deployment) handle type. */
export type AcpHandle = AgentHandle<void, AcpTurnCtx>;

/** The concrete built-in (Job-first) handle type. */
export type BuiltinHandle = AgentHandle<Message[], PiTurnCtx>;

/** The union `WorkloadSpec` the mounted instance dispatches on `kind`. */
export type AgenetesWorkloadSpec =
  | ProfileWorkloadSpec
  | LegacyProfileWorkloadSpec
  | BuiltinWorkloadSpec;

/** The union handle the mounted instance's `create` / `get` return. */
export type AgenetesHandle = AcpHandle | BuiltinHandle;

/** The serializable built-in WorkloadSpec for the standard pi driver. */
export type BuiltinWorkloadSpec = PiWorkloadSpec;

/**
 * The mounted Agenetes instance (I9) — the single L2 object L1 faces. It
 * owns both drivers (registered via the I9.5 builder), the global
 * live-handle table (`create` / `get` / `close`), and the per-namespace
 * durable thread table (`record` / `records`). Both the `external` ACP
 * (Deployment) driver and the `internal` built-in (Job) driver are mounted
 * here symmetrically, so **every** agent turn flows through
 * `agenetes.create(spec).run(...)`; the instance dispatches the driver on
 * `spec.kind` and the lifecycle on `spec.workloadType` (I3.2).
 */
export const agenetes: Agenetes<AgenetesWorkloadSpec, AgenetesHandle> =
  mountAgenetes({
    threadStore: new FileThreadStore(),
    eventLogStore: new FileEventLogStore(),
    turnStore: new FileTurnStore(),
  })
    .register(EXTERNAL_DRIVER_KIND, 'profile', {
      acp: {
        getIdleTimeoutSecs: () =>
          getExternalAgentRuntimeConfig().idleTimeoutSecs,
      },
      resolveManifestRuntime: async (snapshot) => {
        const registry = getAgentTeamRegistry();
        if (!registry) {
          throw new Error('Agent Profile registry is not mounted');
        }
        return registry.resolveManifestRuntime(snapshot);
      },
    })
    .register(INTERNAL_DRIVER_KIND, 'pi', { ports: huabuPiDriverPorts })
    .build<AgenetesWorkloadSpec, AgenetesHandle>();
