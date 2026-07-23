/**
 * `@agenetes/agentlet-host` — the Agenetes agentlet transport host.
 *
 * This package mounts `@agenetes/agentlet-gateway` and the process-lifecycle glue
 * that Sediment (L1) previously carried inline under
 * `apps/server/src/modules/agent/acp/`. It owns exactly one embedded
 * agentlet: it mounts the Agentlet Gateway onto the host's
 * Fastify app, forks & supervises the agentlet daemon child, and
 * authenticates its handshake against a host-injected connection token.
 *
 * It is deliberately host-agnostic: every piece of Sediment deployment
 * knowledge (data directory, daemon entry path, connection token) is
 * injected by the host through {@link mountAgenetes}. The package
 * resolves no paths and reads no Sediment-specific env vars.
 *
 */

import { hostname } from 'node:os';

import { mountAgentTeamRegistry } from './agent-team-mount.js';
import { getDaemonAuth } from './daemon-auth.js';
import { getDaemonSupervisor } from './daemon-supervisor.js';
import { mountAgentletGateway } from './gateway-mount.js';

import type { MountAgentTeamOptions } from './agent-team-mount.js';
import type {
  AgentletConnection,
  AgentletGateway,
  AgentletGatewayOptions,
} from '@agenetes/agentlet-gateway';
import type { FastifyInstance } from 'fastify';

const supervisedAgentletId = hostname();

/** Machine identity used by Sediment's supervised local daemon. */
export function getSupervisedAgentletId(): string {
  return supervisedAgentletId;
}

export { getAgentTeamRegistry } from './agent-team-mount.js';
export {
  ACP_UPGRADE_PATH,
  getAgentletGateway,
  getAgentletServer,
  mountAgentletGateway,
} from './gateway-mount.js';
export {
  getDaemonSupervisor,
  getDaemonStatus,
  _resetDaemonSupervisorForTests,
} from './daemon-supervisor.js';
export { getDaemonAuth, _resetDaemonAuthForTests } from './daemon-auth.js';

export type { AttachOptions } from './daemon-supervisor.js';
export type { MountAgentTeamOptions } from './agent-team-mount.js';
export type {
  MountAcpOptions,
  MountAgentletGatewayOptions,
} from './gateway-mount.js';
export type { AgentletStatus } from '@agenetes/protocol';
// Transport wire types re-surfaced from the underlying agentlet protocol,
// so the ACP driver can type its client against the transport facade
// without importing @agentlet/protocol directly (agentlet stays hidden
// behind this L2 transport package).
export type { AgentletConnection };
export type AgentConnection = Omit<
  AgentletConnection,
  'sessionProfile' | 'agentletProfile'
>;
export type { AcpMessage, LifecycleEvent } from '@agentlet/protocol';
export { AgentletRequestError } from '@agenetes/agentlet-gateway';
export { AgentTeamError } from '@agenetes/agent-team';
export type {
  AcpCommandProfile,
  AgentProfile,
  AgentTeamManifestProfile,
  AgentTeamRegistry,
} from '@agenetes/agent-team';

/** Host-injected configuration for {@link mountAgenetes}. */
export interface MountAgenetesOptions {
  /**
   * Global, non-ephemeral connection token owned by the host (L1
   * config). Every agentlet control channel and per-session relay
   * socket must present this token. Unlike the previous per-fork mint,
   * this value is stable across daemon restarts so agent reachback
   * credentials survive a re-fork.
   */
  connectionToken: string;
  /**
   * Absolute directory for host-owned state used by supervisor cleanup.
   */
  dataDir: string;
  /**
   * Absolute path to the agentlet daemon entry script, resolved by the
   * host from its own deployment layout (dev vs bundled). The host
   * owns this knowledge; this package never resolves paths.
   */
  daemonEntryPath: string;
  /**
   * Host-namespaced environment isolation for the forked daemon and
   * every agent it spawns. `hostEnvPrefix` names the host's env
   * namespace (e.g. `HUABU_`); any inherited variable in that namespace
   * is dropped before the daemon inherits it unless it appears in
   * `hostEnvAllowlist`. Non-namespaced OS/toolchain variables always
   * pass through. Leave unset to inherit the full environment.
   */
  hostEnvPrefix?: string;
  hostEnvAllowlist?: readonly string[];
  /**
   * Override the Gateway authenticator. Defaults to the
   * connection-token validator in {@link getDaemonAuth}.
   */
  authenticate?: AgentletGatewayOptions['authenticateAgentlet'];
  /**
   * Host capabilities for the durable Agent Team control plane. The mounted
   * Gateway is connected internally and is never supplied by the host.
   */
  agentTeam?: MountAgentTeamOptions;
}

/**
 * Mount the Agenetes agentlet transport host onto a Fastify app.
 *
 * Wires the three pieces in dependency order:
 *   1. Store the host connection token so handshakes can be validated.
 *   2. Mount the stateless Agentlet Gateway.
 *   3. Mount the durable Agent Team registry when host capabilities exist.
 *   4. Fork & supervise the agentlet daemon child.
 *
 * Idempotent — the underlying server mount and supervisor attach are
 * each no-ops on a second call.
 */
export function mountAgenetes(
  app: FastifyInstance,
  opts: MountAgenetesOptions,
): AgentletGateway {
  const agentletId = getSupervisedAgentletId();
  getDaemonAuth().configure(agentletId, opts.connectionToken);

  const gateway = mountAgentletGateway(app, {
    authenticate: opts.authenticate,
  });

  if (opts.agentTeam) {
    mountAgentTeamRegistry(app, opts.agentTeam, gateway);
  }

  getDaemonSupervisor().attach(app, {
    daemonEntryPath: opts.daemonEntryPath,
    dataDir: opts.dataDir,
    agentletId,
    hostEnvPrefix: opts.hostEnvPrefix,
    hostEnvAllowlist: opts.hostEnvAllowlist,
  });

  return gateway;
}
