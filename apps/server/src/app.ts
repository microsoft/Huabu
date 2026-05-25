import { tmpdir } from 'node:os';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import debugAcpRoutes from './modules/agent/acp/debug.route.js';
import { acpAgentsRoutes, mountAgentletServer } from './modules/agent/acp/index.js';
import agentRoutes from './modules/agent/agent.route.js';
import intentRoutes from './modules/agent/intent.route.js';
import llmRoutes from './modules/agent/llm.route.js';
import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import webRoutes from './modules/web/web.route.js';
import {
  initWorkspaceFromEnv,
  isWorkspaceConfigured,
} from './modules/workspace.js';
import workspaceRoutes from './modules/workspace.route.js';
import { preloadSkills } from './prompt/skill-loader.js';

// Lock the workspace at startup if SEDIMENT_WORKSPACE is set (managed mode).
// In free mode this is a no-op and the client will activate at runtime.
initWorkspaceFromEnv();

// Eagerly scan + validate every SKILL.md frontmatter at boot so a malformed
// skill (missing `appliesTo`, mismatched `id`, etc.) crashes the process at
// startup instead of surfacing as a 500 on the first agent request. The
// catalogue rendered into every system prompt depends on this metadata
// being consistent — see apps/server/src/prompt/skill-loader.ts.
preloadSkills();

export const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 100 * 1024 * 1024, // 100MB for file uploads
});

// Register response compression
app.register(compress);

// Register CORS
app.register(cors, {
  origin: true, // Allow all origins in development, specify domains in production
});

// Register multipart for file uploads
// Max file size: 100MB
app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
});

// ── HTTP Basic Auth gate ─────────────────────────────────────────────
// When SEDIMENT_BASIC_AUTH_USER and SEDIMENT_BASIC_AUTH_PASS are both set,
// every request (except CORS preflight) must include matching Basic Auth
// credentials. The Vite dev server applies the same check at the edge,
// but the backend must enforce it independently because port 3001 may be
// reachable directly (e.g. when bound to 0.0.0.0 on a public IP).
const basicAuthUser = process.env.SEDIMENT_BASIC_AUTH_USER;
const basicAuthPass = process.env.SEDIMENT_BASIC_AUTH_PASS;
if (basicAuthUser && basicAuthPass) {
  const expected =
    'Basic ' +
    Buffer.from(`${basicAuthUser}:${basicAuthPass}`, 'utf8').toString('base64');
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    if (request.headers.authorization === expected) return;
    reply
      .header('WWW-Authenticate', 'Basic realm="Sediment"')
      .status(401)
      .send({ message: 'Authentication required' });
  });
  app.log.info('Basic Auth enabled for all routes');
}

// Register @fastify/static to enable `reply.sendFile()`.
// Actual artifact serving uses a dynamic root resolved at request time
// (see artifact.route.ts), so we pass `serve: false` here and use the
// OS temp dir as a throwaway root that is never directly served.
app.register(staticPlugin, {
  root: tmpdir(),
  serve: false,
});

// Guard: reject requests to non-workspace routes when workspace is not yet configured.
// The workspace routes themselves are always allowed so the client can set the path.
app.addHook('preHandler', async (request, reply) => {
  const url = request.url;
  if (
    !isWorkspaceConfigured() &&
    url.startsWith('/api') &&
    !url.startsWith('/api/workspace') &&
    !url.startsWith('/api/llm')
  ) {
    return reply.status(503).send({
      message:
        'Workspace has not been configured yet. Please set a workspace path first.',
    });
  }
});

app.register(agentRoutes, { prefix: '/api/agent' });
app.register(canvasRoutes, { prefix: '/api/canvas' });
app.register(webRoutes, { prefix: '/api/web' });
app.register(artifactRoute, { prefix: '/api/canvas' });

app.register(intentRoutes, { prefix: '/api/intent' });
app.register(llmRoutes, { prefix: '/api/llm' });
app.register(workspaceRoutes, { prefix: '/api/workspace' });

// ── External agent (ACP) bridge ───────────────────────────────────────
// Phase 0+1 wiring: mount @agentlet/server (WS upgrade at /api/acp/agent)
// and the Phase 1 debug endpoint (POST /api/debug/acp-prompt) behind the
// same feature flag so the default startup path is unchanged. Set
// SEDIMENT_ENABLE_ACP=1 to enable. See modules/agent/acp/README.md.
//
// The agents-list route is registered *unconditionally* so the front-end
// has one URL to call regardless of flag state — it reports
// `{ enabled: false, agents: [] }` when the bridge isn't mounted.
app.register(acpAgentsRoutes, { prefix: '/api/acp' });
if (process.env.SEDIMENT_ENABLE_ACP === '1') {
  mountAgentletServer(app);
  app.register(debugAcpRoutes, { prefix: '/api/debug' });
  app.log.info('ACP (external agent) bridge + debug route enabled');
}
