// The ACP `AgentDriver` + its I9.5 driver factory — the standard
// "external agent" driver, now living inside `@agenetes/acp-driver` (its
// natural home) instead of being assembled object-by-object in the host.
//
// `acpDriverFactory` is the driver-factory-dictionary entry the mounted
// Agenetes instance registers (README I9.5): `(cfg) => AgentDriver`. Its
// config is empty today — the live ACP session is still resolved per turn
// by the composition shell and handed in on {@link AcpTurnCtx} — and grows
// the ACP-private transport backing (`{ app, connectionToken, dataDir,
// daemonEntryPath, logger }`) once the handle self-resolves its own
// session (M5 C4b). See docs/proposals/layered-architecture.md §7 (M5).

import {
  ACP_CAPABILITIES,
  AcpAgentHandle,
  type AcpTurnCtx,
  type InStreamEvent,
  type PreparedAcpPrompt,
} from './handle.js';

import type { AgentDriver } from '@agenetes/runtime';
import type { Message } from '@earendil-works/pi-ai';

/**
 * Dispatch key for the external ACP (agentlet) driver — the I5 contract
 * `kind` the instance's `create(spec)` resolves on. (The I5.1 rename to
 * the contract kind `external` is a separate, later step — M5 item 15.)
 */
export const ACP_DRIVER_KIND = 'acp';

/**
 * The minimal `WorkloadSpec` projection the ACP driver reads at `create`
 * (I9.3 `resolve(spec.kind).create(spec)`). Today it needs only the
 * addressable `threadId`; the live session is still resolved per turn by
 * the composition shell and handed in on {@link AcpTurnCtx}. C4b grows the
 * projection to the full baked spec (binding / cwd / recipe / namespace /
 * env) once the handle self-resolves its own session. A full `WorkloadSpec`
 * satisfies this structurally, so the mounted instance can pass its spec
 * straight through.
 */
export interface AcpCreateSpec {
  /** The L1-minted addressable id this Deployment is keyed by (I4.2). */
  readonly threadId: string;
}

/**
 * The concrete ACP {@link AgentDriver} type (a Deployment: full control +
 * `session/load`). Generic over the host request shape (`TRequest`), which
 * the handle never inspects — it only forwards it to `render`.
 */
export type AcpAgentDriver<TRequest = unknown> = AgentDriver<
  AcpCreateSpec,
  TRequest,
  PreparedAcpPrompt,
  Message[],
  InStreamEvent,
  AcpTurnCtx
>;

/**
 * Bootstrap config for {@link acpDriverFactory} (the I9.5 `factoryArgs`).
 * Empty today — the handle still receives its live session via the turn
 * ctx; C4b adds the ACP-private transport backing here.
 */
export type AcpDriverFactoryConfig = void;

/**
 * The I9.5 driver factory for the standard ACP driver. Produces a driver
 * whose `create(spec)` mints a long-lived {@link AcpAgentHandle} keyed by
 * `spec.threadId`.
 */
export function acpDriverFactory<TRequest = unknown>(
  _config?: AcpDriverFactoryConfig,
): AcpAgentDriver<TRequest> {
  return {
    kind: ACP_DRIVER_KIND,
    capabilities: ACP_CAPABILITIES,
    create: (spec) => new AcpAgentHandle<TRequest>(spec.threadId),
  };
}
