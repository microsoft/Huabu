import { AgentletGateway } from '@agenetes/agentlet-gateway';

import { getDaemonAuth } from './daemon-auth.js';

import type { AgentletGatewayOptions } from '@agenetes/agentlet-gateway';
import type { FastifyInstance } from 'fastify';

/**
 * Path prefix on the host HTTP server where agentlet processes connect
 * over WebSocket. The agentlet CLI sends `agentlet/hello` (for the
 * control channel) or `agent/hello` (for per-session relay) here.
 *
 * The full URL given to users is `ws://<host>:<port>/api/acp/agent`
 * (or wss:// in prod). Token is carried in the `Authorization` header
 * or `?token=` query param — see the agentlet protocol spec.
 *
 * Note: this path uses the host's standard `/api` prefix but bypasses
 * Fastify's route/hook chain because it's attached to the raw HTTP
 * server's `upgrade` event. Basic Auth (if enabled) does NOT protect
 * this endpoint — agentlet's own token check in the hello handshake
 * is the auth boundary.
 */
export const ACP_UPGRADE_PATH = '/api/acp/agent';

let instance: AgentletGateway | null = null;

export interface MountAgentletGatewayOptions {
  /**
   * Override the default authenticator. By default we delegate to
   * {@link getDaemonAuth}, which only accepts connections carrying the
   * host-injected `connectionToken` set at `mountAgenetes` time. There
   * is no persistence and no pairing UI: the only legitimate connection
   * comes from the agentlet we just forked.
   */
  authenticate?: AgentletGatewayOptions['authenticateAgentlet'];
}

/**
 * Mount `@agenetes/agentlet-gateway` on the running Fastify HTTP server so the
 * embedded agentlet (forked by {@link ./daemon-supervisor.ts}) can
 * connect over WebSocket. Idempotent — calling twice returns the same
 * instance.
 */
export function mountAgentletGateway(
  app: FastifyInstance,
  opts: MountAgentletGatewayOptions,
): AgentletGateway {
  if (instance) return instance;

  const daemonAuth = getDaemonAuth();

  const gateway = new AgentletGateway({
    authenticateAgentlet:
      opts.authenticate ??
      ((agentletId, token) => daemonAuth.validateAgentlet(agentletId, token)),
    onConnection: (connection) => {
      app.log.info(
        {
          agentletId: connection.agentletId,
          sessionId: connection.sessionId,
          role: connection.role,
        },
        '[acp] agentlet connection established',
      );
    },
    onReconnection: (connection) => {
      app.log.info(
        {
          agentletId: connection.agentletId,
          sessionId: connection.sessionId,
          role: connection.role,
        },
        '[acp] agentlet connection re-established',
      );
    },
    onDisconnection: (connection, reason) => {
      app.log.info(
        {
          agentletId: connection.agentletId,
          sessionId: connection.sessionId,
          reason,
        },
        '[acp] agentlet connection disconnected',
      );
    },
    logger: {
      info: (fields, message) => app.log.info(fields, message),
      warn: (fields, message) => app.log.warn(fields, message),
    },
  });

  // Attach the WS upgrade listener once the underlying HTTP server is bound.
  // Fastify exposes `app.server` after `listen()`, which is what `onReady` waits for.
  app.addHook('onReady', async () => {
    app.server.on('upgrade', (req, socket, head) => {
      if (req.url && req.url.startsWith(ACP_UPGRADE_PATH)) {
        gateway.handleUpgrade(req, socket, head);
      }
      // Other upgrade requests are intentionally ignored here — let any
      // future WS plugin handle its own paths.
    });
    app.log.info(
      `[acp] Agentlet Gateway mounted at ws://<host>${ACP_UPGRADE_PATH}`,
    );
  });

  app.addHook('preClose', async () => {
    gateway.close();
    instance = null;
  });

  instance = gateway;
  return gateway;
}

/** Returns the singleton Gateway, or null if it has not been mounted. */
export function getAgentletGateway(): AgentletGateway | null {
  return instance;
}

/** @deprecated Use {@link getAgentletGateway}. */
export const getAgentletServer = getAgentletGateway;

/** @deprecated Use {@link MountAgentletGatewayOptions}. */
export type MountAcpOptions = MountAgentletGatewayOptions;
