import { tmpdir } from 'node:os';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import {
  acpAgentsRoutes,
  acpConfigRoutes,
  acpThreadsRoutes,
  applyAcpConfig,
  loadAcpConfig,
  mountAgentletServer,
} from './modules/agent/acp/index.js';
import agentRoutes from './modules/agent/agent.route.js';
import intentRoutes from './modules/agent/intent.route.js';
import llmRoutes from './modules/agent/llm.route.js';
import { registerOpCounterHook } from './modules/agent/memory/op-counter-hook.js';
import skillsRoutes from './modules/agent/skills.route.js';
import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import {
  hostGuardPlugin,
  originGuardPlugin,
  resolveAllowedHostnames,
} from './modules/security/index.js';
import webRoutes from './modules/web/web.route.js';
import {
  initWorkspaceFromEnv,
  isWorkspaceConfigured,
} from './modules/workspace.js';
import workspaceRoutes from './modules/workspace.route.js';
import { preloadSkills } from './prompt/index.js';

// Lock the workspace at startup if HUABU_WORKSPACE is set (managed mode).
// In free mode this is a no-op and the client will activate at runtime.
initWorkspaceFromEnv();

// Eagerly scan + validate every SKILL.md frontmatter at boot so a malformed
// skill (missing `appliesTo`, mismatched `id`, etc.) crashes the process at
// startup instead of surfacing as a 500 on the first agent request. The
// catalogue rendered into every system prompt depends on this metadata
// being consistent — see apps/server/src/prompt/skills/loader.ts.
preloadSkills();

export const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 100 * 1024 * 1024, // 100MB for file uploads
});

// Register response compression
app.register(compress);

// ── CORS ─────────────────────────────────────────────────────────────
// Locked down to a static allowlist derived from `HUABU_ALLOWED_HOSTS`
// plus the loopback defaults — see `modules/security`. The cross-origin
// write guard (see `origin-guard.ts`) enforces the same allowlist for
// non-safe methods at the HTTP layer using `Sec-Fetch-Site` with an
// `Origin`/loopback fallback; this CORS config keeps the browser from
// even attempting cross-origin reads of sensitive GET endpoints. Any
// scheme/port is accepted on an allowed hostname so
// `http://localhost:5173` (Vite dev) and `https://sediment.example`
// (reverse proxy) both work without further configuration.
const allowedHostnames = resolveAllowedHostnames();
app.register(cors, {
  origin: (origin, cb) => {
    // Non-browser callers (curl, server-to-server, native apps) omit
    // Origin entirely — allow them; the Host guard already validates
    // their target hostname.
    if (!origin) return cb(null, true);
    try {
      const parsed = new URL(origin);
      // URL.hostname strips the port and lowercases; IPv6 literals
      // come back without the brackets, so re-add them to match the
      // allowlist's canonical form.
      const hostname = parsed.hostname.includes(':')
        ? `[${parsed.hostname}]`
        : parsed.hostname;
      cb(null, allowedHostnames.has(hostname));
    } catch {
      cb(null, false);
    }
  },
  credentials: false,
});

// ── Network security guards ──────────────────────────────────────────
// Registered before basic-auth so misaddressed requests fail fast with
// a clear 403 instead of an auth challenge. Order matters:
//   hostGuard → originGuard → basic-auth → workspace guard → routes.
app.register(hostGuardPlugin);
app.register(originGuardPlugin);

// Register multipart for file uploads
// Max file size: 100MB
app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
  },
});

// ── HTTP Basic Auth gate ─────────────────────────────────────────────
// When HUABU_BASIC_AUTH_USER and HUABU_BASIC_AUTH_PASS are both set,
// every request (except CORS preflight) must include matching Basic Auth
// credentials. The Vite dev server applies the same check at the edge,
// but the backend must enforce it independently because port 3001 may be
// reachable directly (e.g. when bound to 0.0.0.0 on a public IP).
const basicAuthUser = process.env.HUABU_BASIC_AUTH_USER;
const basicAuthPass = process.env.HUABU_BASIC_AUTH_PASS;
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
app.register(skillsRoutes, { prefix: '/api/skills' });
app.register(workspaceRoutes, { prefix: '/api/workspace' });

// ── External agent (ACP) bridge ───────────────────────────────────────
// Mount @agentlet/server (WS upgrade at /api/acp/agent) *unconditionally*.
// The security boundary is the in-memory token store, which is seeded
// from `data/acp-config.json` at startup. While the user has ACP
// disabled (default for fresh installs), the store is empty and every
// `bridge/hello` is rejected — but the endpoint stays reachable, so
// flipping the toggle from the Settings UI takes effect immediately
// with no server restart.
//
// The Settings UI is the only way to enable the bridge — there is no
// `.env`-based override. See `modules/agent/acp/config.ts`.
const acpConfig = loadAcpConfig();
applyAcpConfig(acpConfig);
mountAgentletServer(app);
app.register(acpAgentsRoutes, { prefix: '/api/acp' });
app.register(acpConfigRoutes, { prefix: '/api/acp' });
app.register(acpThreadsRoutes, { prefix: '/api/acp' });
if (acpConfig.enabled) {
  app.log.info('[acp] bridge enabled');
} else {
  app.log.info(
    '[acp] bridge disabled — enable from the Settings UI to allow agentlet connections',
  );
}

// Memory op-counter: bump the per-canvas counter on every successful
// mutating HTTP request scoped to a canvas. Registered last so all
// route handlers are already in place. See
// `modules/agent/memory/op-counter-hook.ts` for the policy details
// (which URLs are skipped, how the weight is derived).
registerOpCounterHook(app);
