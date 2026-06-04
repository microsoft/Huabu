import { AgentletServer } from '@agentlet/server';

import { getDaemonAuth } from './daemon-auth.js';

import type { AgentletServerOptions } from '@agentlet/protocol';
import type { FastifyInstance } from 'fastify';

/**
 * Path prefix on Sediment's HTTP server where agentlet processes connect over
 * WebSocket. Agentlet's CLI sends bridge/hello here after upgrade.
 *
 * The full URL given to users is `ws://<host>:<port>/api/acp/agent` (or wss://
 * in prod). Token + canvasId are carried inside bridge/hello, not in the URL.
 *
 * Note: this path uses Sediment's standard `/api` prefix but bypasses Fastify's
 * route/hook chain because it's attached to the raw HTTP server's `upgrade`
 * event. Basic Auth (if enabled) does NOT protect this endpoint — agentlet's
 * own token check inside bridge/hello is the auth boundary.
 */
export const ACP_UPGRADE_PATH = '/api/acp/agent';

let instance: AgentletServer | null = null;

export interface MountAcpOptions {
  /**
   * Override the default authenticator. By default we delegate to
   * {@link getDaemonAuth}, which only accepts `bridge/hello` calls
   * carrying `mode: 'daemon'` plus the token minted by the
   * supervisor at boot — see `./daemon-supervisor.ts`. There is no
   * persistence and no pairing UI: the only legitimate connection
   * comes from the daemon we just forked.
   */
  authenticate?: AgentletServerOptions['authenticate'];
}

/**
 * Embed `@agentlet/server` into the running Fastify HTTP server so the
 * embedded agentlet daemon (forked by {@link getDaemonSupervisor}) can
 * connect over WebSocket. Idempotent — calling twice returns the same
 * instance.
 */
export function mountAgentletServer(
  app: FastifyInstance,
  opts: MountAcpOptions = {},
): AgentletServer {
  if (instance) return instance;

  const daemonAuth = getDaemonAuth();

  const server = new AgentletServer({
    authenticate:
      opts.authenticate ??
      (async (token, meta) => daemonAuth.validate(token, meta)),
    onConnection: (agent) => {
      app.log.info(
        { agentId: agent.agentId, agentInfo: agent.agentInfo },
        '[acp] agent connected',
      );
    },
    onReconnection: (agent) => {
      app.log.info({ agentId: agent.agentId }, '[acp] agent reconnected');
    },
    onDisconnection: (agent, reason) => {
      // Daemon-mode connections do not need any post-disconnect
      // bookkeeping — the supervisor owns the daemon's lifecycle and
      // will surface failures through `/api/acp/daemon`. For agent
      // (per-CLI) connections we just emit a log line; reconnect /
      // retry is the agentlet client's responsibility.
      app.log.info(
        { agentId: agent.agentId, reason },
        '[acp] agent disconnected',
      );
    },
  });

  // Attach the WS upgrade listener once the underlying HTTP server is bound.
  // Fastify exposes `app.server` after `listen()`, which is what `onReady` waits for.
  app.addHook('onReady', async () => {
    app.server.on('upgrade', (req, socket, head) => {
      if (req.url && req.url.startsWith(ACP_UPGRADE_PATH)) {
        server.handleUpgrade(req, socket, head);
      }
      // Other upgrade requests are intentionally ignored here — let any
      // future WS plugin handle its own paths.
    });
    app.log.info(
      `[acp] agentlet server mounted at ws://<host>${ACP_UPGRADE_PATH}`,
    );
  });

  app.addHook('onClose', async () => {
    await server.close();
    instance = null;
  });

  instance = server;
  return server;
}

/** Returns the singleton instance, or null if `mountAgentletServer` was never called. */
export function getAgentletServer(): AgentletServer | null {
  return instance;
}
