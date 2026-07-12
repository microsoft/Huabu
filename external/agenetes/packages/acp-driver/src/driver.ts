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
  AcpAgentHandle,
  type AcpCreateSpec,
  type AcpTurnCtx,
  type InStreamEvent,
} from './handle.js';

import type { AgentSubmission } from '@agenetes/protocol';
import type { AgentDriver } from '@agenetes/runtime';

// `AcpCreateSpec` (the create-time WorkloadSpec projection the handle
// bakes) is defined next to the handle that consumes it; re-exported here
// so the driver's public surface stays the stable import point.
export type { AcpCreateSpec } from './handle.js';

/**
 * The concrete ACP {@link AgentDriver} type. Generic over the submission's
 * opaque host source while lowering only protocol-owned canonical inputs.
 */
export type AcpAgentDriver<
  TSubmission extends AgentSubmission = AgentSubmission,
> = AgentDriver<AcpCreateSpec, TSubmission, void, InStreamEvent, AcpTurnCtx>;

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
export function acpDriverFactory<
  TSubmission extends AgentSubmission = AgentSubmission,
>(_config?: AcpDriverFactoryConfig): AcpAgentDriver<TSubmission> {
  return {
    create: (spec, context) => new AcpAgentHandle<TSubmission>(spec, context),
  };
}
