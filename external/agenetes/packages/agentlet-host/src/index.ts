/**
 * `@agenetes/agentlet-host` — the Agenetes agentlet transport host.
 *
 * This package wraps `@agentlet/server` and the process-lifecycle glue
 * that Sediment (L1) previously carried inline under
 * `apps/server/src/modules/agent/acp/`. It owns exactly one embedded
 * agentlet: it mounts the agentlet WebSocket server onto the host's
 * Fastify app, forks & supervises the agentlet daemon child, and
 * authenticates its handshake against a host-injected connection token.
 *
 * It is deliberately host-agnostic: every piece of Sediment deployment
 * knowledge (data directory, daemon entry path, connection token) is
 * injected by the host through {@link mountAgenetes}. The package
 * resolves no paths and reads no Sediment-specific env vars.
 *
 * The internal transport/control re-split described in the layered
 * architecture proposal (§6.1) is intentionally deferred — for now the
 * whole agentlet server is wrapped as a single unit (option B).
 */

import { join } from 'node:path';

import { getDaemonAuth } from './daemon-auth.js';
import { getDaemonSupervisor } from './daemon-supervisor.js';
import { mountAgentletServer } from './server-mount.js';

import type { AgentletServer } from '@agentlet/server';
import type { AgentletServerOptions } from '@agentlet/protocol';
import type { FastifyInstance } from 'fastify';

export { ACP_UPGRADE_PATH, getAgentletServer } from './server-mount.js';
export {
  getDaemonSupervisor,
  getDaemonStatus,
  _resetDaemonSupervisorForTests,
} from './daemon-supervisor.js';
export {
  getDaemonAuth,
  _resetDaemonAuthForTests,
} from './daemon-auth.js';

export type { AttachOptions } from './daemon-supervisor.js';
export type { MountAcpOptions } from './server-mount.js';
export type { AgentletStatus } from '@agenetes/protocol';
// Transport wire types re-surfaced from the underlying agentlet protocol,
// so the ACP driver can type its client against the transport facade
// without importing @agentlet/protocol directly (agentlet stays hidden
// behind this L2 transport package).
export type { AgentConnection, AcpMessage } from '@agentlet/protocol';

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
   * Absolute directory for host-owned persistent state. The agentlet
   * server's stores live under `<dataDir>/agentlet`.
   */
  dataDir: string;
  /**
   * Absolute path to the agentlet daemon entry script, resolved by the
   * host from its own deployment layout (dev vs bundled). The host
   * owns this knowledge; this package never resolves paths.
   */
  daemonEntryPath: string;
  /**
   * Override the agentlet server authenticator. Defaults to the
   * connection-token validator in {@link getDaemonAuth}.
   */
  authenticate?: AgentletServerOptions['authenticate'];
}

/**
 * Mount the Agenetes agentlet transport host onto a Fastify app.
 *
 * Wires the three pieces in dependency order:
 *   1. Store the host connection token so handshakes can be validated.
 *   2. Embed the agentlet WebSocket server (stores under `<dataDir>/agentlet`).
 *   3. Fork & supervise the agentlet daemon child.
 *
 * Idempotent — the underlying server mount and supervisor attach are
 * each no-ops on a second call.
 */
export function mountAgenetes(
  app: FastifyInstance,
  opts: MountAgenetesOptions,
): AgentletServer {
  getDaemonAuth().setDaemonToken(opts.connectionToken);

  const server = mountAgentletServer(app, {
    storeDir: join(opts.dataDir, 'agentlet'),
    authenticate: opts.authenticate,
  });

  getDaemonSupervisor().attach(app, {
    daemonEntryPath: opts.daemonEntryPath,
    dataDir: opts.dataDir,
  });

  return server;
}
