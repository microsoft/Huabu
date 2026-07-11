/**
 * Host-side driver registration — where L1 mounts the L2 {@link Agenetes}
 * instance (the object the rest of `apps/server` faces) and keeps the one
 * canvas-coupled driver it must still own itself.
 *
 * The standard ACP ("external") driver now ships inside
 * `@agenetes/acp-driver` and self-resolves its own session per turn, so it
 * is registered into the mounted instance through the I9.5
 * driver-factory-dictionary builder ({@link mountAgenetes}). The built-in
 * path is now in transition: L1 still owns the Huabu-specific adapter
 * (model/account/tool ports + spec compilation), but the execution logic
 * itself is delegated to the standard `@agenetes/pi-driver`. See
 * docs/proposals/pi-harness-driver-refactor-plan.md.
 */

import {
  acpDriverFactory,
  type AcpCreateSpec,
  type AcpTurnCtx,
  type PreparedAcpPrompt,
} from '@agenetes/acp-driver';
import {
  mountAgenetes,
  FileThreadStore,
  FileEventLogStore,
  FileTurnStore,
} from '@agenetes/agenetes';
import {
  piDriverFactory,
  type PiRenderedInput,
  type PiTurnCtx,
  type PiWorkloadSpec,
} from '@agenetes/pi-driver';

import {
  type AgentDriver,
  type AgentHandle,
  type AgentRequest,
  type InStreamEvent,
} from './handle.js';
import { huabuPiDriverPorts } from './pi-driver.js';

import type { Agenetes } from '@agenetes/agenetes';
import type { WorkloadType } from '@agenetes/protocol';

/**
 * The built-in driver's factory-dictionary name (its *implementation*
 * identity, I5.1) — the `.addFactory(BUILTIN_FACTORY_NAME, …)` key,
 * mirroring the ACP driver's {@link ACP_FACTORY_NAME}. `'builtin'` was the
 * factory name all along, not the contract kind (that is
 * {@link INTERNAL_DRIVER_KIND}).
 */
export const BUILTIN_FACTORY_NAME = 'builtin';

/**
 * The built-in driver's dispatch `kind` — the I5 *contract* kind L1 injects
 * at `register()` (I5.1 alias / I9.5), the `internal` counterpart to the
 * ACP driver's `external` ({@link EXTERNAL_DRIVER_KIND}). It is L1's to
 * choose at mount, and rides `spec.kind` on the built-in `WorkloadSpec`.
 */
export const INTERNAL_DRIVER_KIND = 'internal';

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

/** The concrete built-in (Job-first) handle type. */
export type BuiltinHandle = AgentHandle<PiRenderedInput, PiTurnCtx>;

/** The union `WorkloadSpec` the mounted instance dispatches on `kind`. */
export type AgenetesWorkloadSpec = AcpWorkloadSpec | BuiltinWorkloadSpec;

/** The union handle the mounted instance's `create` / `get` return. */
export type AgenetesHandle = AcpHandle | BuiltinHandle;

/** The serializable built-in WorkloadSpec — now the standard pi-driver spec. */
export type BuiltinWorkloadSpec = PiWorkloadSpec;

/**
 * The L1 wrapper factory for the built-in ("internal") driver.
 *
 * The execution logic now lives in the standard `@agenetes/pi-driver`;
 * this host-side wrapper only injects the Huabu-specific ports once and
 * exposes the result under the existing internal contract kind.
 */
export const builtinDriverFactory = (
  _config?: void,
): AgentDriver<
  BuiltinWorkloadSpec,
  AgentRequest,
  PiRenderedInput,
  PiRenderedInput,
  InStreamEvent,
  PiTurnCtx
> => piDriverFactory<AgentRequest>({ ports: huabuPiDriverPorts });

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
    .addFactory(ACP_FACTORY_NAME, acpDriverFactory<AgentRequest>)
    .register(EXTERNAL_DRIVER_KIND, ACP_FACTORY_NAME)
    .addFactory(BUILTIN_FACTORY_NAME, builtinDriverFactory)
    .register(INTERNAL_DRIVER_KIND, BUILTIN_FACTORY_NAME)
    .build<AgenetesWorkloadSpec, AgenetesHandle>();
