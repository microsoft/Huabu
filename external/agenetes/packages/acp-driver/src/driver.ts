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
  type AcpCreateSpec,
  type AcpTurnCtx,
  type InStreamEvent,
  type PreparedAcpPrompt,
} from './handle.js';

import type { AgentDriver } from '@agenetes/runtime';
import type { Message } from '@earendil-works/pi-ai';

// `AcpCreateSpec` (the create-time WorkloadSpec projection the handle
// bakes) is defined next to the handle that consumes it; re-exported here
// so the driver's public surface stays the stable import point.
export type { AcpCreateSpec } from './handle.js';

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
 * Empty — the ACP session transport is reached through the
 * `@agenetes/agentlet-host` module getter (wired at mount), and every
 * per-thread input (binding / cwd / recipe / namespace / env) rides the
 * baked {@link AcpCreateSpec}, so the factory needs no config.
 */
export type AcpDriverFactoryConfig = void;

/**
 * The I9.5 driver factory for the standard ACP driver. Produces a driver
 * whose `create(spec)` mints a long-lived {@link AcpAgentHandle} that bakes
 * `spec` and self-resolves its live session per turn (I9.3).
 */
export function acpDriverFactory<TRequest = unknown>(
  _config?: AcpDriverFactoryConfig,
): AcpAgentDriver<TRequest> {
  return {
    capabilities: ACP_CAPABILITIES,
    create: (spec, priorState) =>
      new AcpAgentHandle<TRequest>(spec, priorState),
  };
}
