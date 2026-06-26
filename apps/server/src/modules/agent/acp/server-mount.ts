import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentletServer } from '@agentlet/server';

import { getDaemonAuth } from './daemon-auth.js';
import { getDataDir } from '../../../data-dir.js';

import type { AgentletServerOptions } from '@agentlet/protocol';
import type { FastifyInstance } from 'fastify';

// Resolve HRT script path relative to this module
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const HRT_SCRIPT_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'reachback',
  'huabu-reachback-tool.mjs',
);

/**
 * Path prefix on Sediment's HTTP server where agentlet processes connect
 * over WebSocket. The agentlet CLI sends `agentlet/hello` (for the
 * control channel) or `agent/hello` (for per-session relay) here.
 *
 * The full URL given to users is `ws://<host>:<port>/api/acp/agent`
 * (or wss:// in prod). Token is carried in the `Authorization` header
 * or `?token=` query param — see the agentlet protocol spec.
 *
 * Note: this path uses Sediment's standard `/api` prefix but bypasses
 * Fastify's route/hook chain because it's attached to the raw HTTP
 * server's `upgrade` event. Basic Auth (if enabled) does NOT protect
 * this endpoint — agentlet's own token check in the hello handshake
 * is the auth boundary.
 */
export const ACP_UPGRADE_PATH = '/api/acp/agent';

let instance: AgentletServer | null = null;

export interface MountAcpOptions {
  /**
   * Override the default authenticator. By default we delegate to
   * {@link getDaemonAuth}, which only accepts connections carrying the
   * token minted by the supervisor at boot — see
   * `./daemon-supervisor.ts`. There is no persistence and no pairing
   * UI: the only legitimate connection comes from the agentlet we just
   * forked.
   */
  authenticate?: AgentletServerOptions['authenticate'];
}

/**
 * Embed `@agentlet/server` into the running Fastify HTTP server so the
 * embedded agentlet (forked by {@link getDaemonSupervisor}) can connect
 * over WebSocket. Idempotent — calling twice returns the same instance.
 */
export function mountAgentletServer(
  app: FastifyInstance,
  opts: MountAcpOptions = {},
): AgentletServer {
  if (instance) return instance;

  const daemonAuth = getDaemonAuth();
  // Global, not per-canvas: the AgentletServer is a singleton whose
  // sessions.db spans every canvas, so it lives in the server-level
  // data directory (alongside canvas.sqlite, llm-config.json, etc.)
  // rather than inside a workspace's per-canvas .history/chat/ tree.
  const storeDir = join(getDataDir(), 'agentlet');

  const server = new AgentletServer({
    storeDir,
    authenticate:
      opts.authenticate ??
      (async (token, meta) => daemonAuth.validate(token, meta)),
    onConnection: (agent) => {
      app.log.info(
        { sessionId: agent.sessionId, role: agent.role },
        '[acp] agent connected',
      );
      // Push reachback tools to newly-connected agentlet daemons
      if (agent.role === 'agentlet') {
        pushReachbackTools(agent.sessionId);
      }
    },
    onReconnection: (agent) => {
      app.log.info(
        { sessionId: agent.sessionId, role: agent.role },
        '[acp] agent reconnected',
      );
      // Re-push reachback tools on resume — the daemon's cache dir may have
      // been cleared while it was suspended.
      if (agent.role === 'agentlet') {
        pushReachbackTools(agent.sessionId);
      }
    },
    onDisconnection: (agent, reason) => {
      app.log.info(
        { sessionId: agent.sessionId, reason },
        '[acp] agent disconnected',
      );
    },
  });

  // Push the HRT script to an agentlet daemon over its control channel.
  // Called on both initial connect and resume (the daemon's cache dir may
  // have been cleared while suspended).
  function pushReachbackTools(agentletSessionId: string): void {
    try {
      const content = readFileSync(HRT_SCRIPT_PATH, 'utf8');
      server.sendResource(agentletSessionId, {
        destination: '${AGENTLET_REACHBACK_DIR}/huabu-reachback-tool.mjs',
        content,
      });
      app.log.info('[acp] reachback tools pushed to agentlet');
    } catch (err) {
      app.log.warn({ err }, '[acp] failed to push reachback tools');
    }
  }

  // Attach the WS upgrade listener once the underlying HTTP server is bound.
  // Fastify exposes `app.server` after `listen()`, which is what `onReady` waits for.
  app.addHook('onReady', async () => {
    // Initialize persistent stores before accepting connections.
    await server.init();
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
