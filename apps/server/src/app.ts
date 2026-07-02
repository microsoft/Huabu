import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify, type FastifyBaseLogger } from 'fastify';

import { getDataDir } from './data-dir.js';
import { getDaemonAuth } from './modules/agent/acp/daemon-auth.js';
import {
  acpAgentCliRoutes,
  acpAgentletRoutes,
  acpProfilesRoutes,
  acpThreadsRoutes,
  getDaemonSupervisor,
  mountAgentletServer,
} from './modules/agent/acp/index.js';
import agentRoutes from './modules/agent/agent.route.js';
import intentRoutes from './modules/agent/intent.route.js';
import llmRoutes from './modules/agent/llm.route.js';
import { registerOpCounterHook } from './modules/agent/memory/op-counter-hook.js';
import skillsRoutes from './modules/agent/skills.route.js';
import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import externalNoteRoutes from './modules/canvas/external.route.js';
import syncRoutes from './modules/canvas/sync.route.js';
import rfsRoutes from './modules/remote_fs/rfs.route.js';
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
import { logger } from './utils/logger.js';

// Lock the workspace at startup if HUABU_WORKSPACE is set (managed mode).
// In free mode this is a no-op and the client will activate at runtime.
initWorkspaceFromEnv();

// Eagerly scan + validate every SKILL.md frontmatter at boot so a malformed
// skill (missing `appliesTo`, mismatched `id`, etc.) crashes the process at
// startup instead of surfacing as a 500 on the first agent request. The
// catalogue rendered into every system prompt depends on this metadata
// being consistent — see apps/server/src/prompt/skills/loader.ts.
preloadSkills();

// Inject our shared pino instance (see utils/logger.ts) so that
// Fastify's request-scoped `request.log.*` and service-layer
// `getLogger('subsystem')` calls share the same streams, level config,
// and on-disk log file. Avoids the historical split between Fastify's
// own structured logs and ad-hoc `console.*` calls scattered across
// the service layer.
//
// The cast through `FastifyBaseLogger` is a TS-only workaround:
// pino 10 added `msgPrefix` to its `BaseLogger` interface but
// Fastify 5's `FastifyBaseLogger` doesn't declare it. Runtime is
// fully compatible — pino's `Logger` is a superset of every method
// Fastify actually invokes. Without the cast, every downstream
// plugin / route that takes `FastifyInstance` would see the generic
// resolved to pino's stricter `Logger` and fail to type-check.
export const app = fastify({
  loggerInstance: logger as unknown as FastifyBaseLogger,
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

// ── HTTP Auth gate ───────────────────────────────────────────────────
// Two auth mechanisms coexist:
//
// 1. Basic Auth (browser/Vite): when HUABU_BASIC_AUTH_USER and
//    HUABU_BASIC_AUTH_PASS are set, requests with matching Basic creds
//    are accepted.
//
// 2. Bearer token (RFS): requests with
//    `Authorization: Bearer <AGENTLET_TOKEN>` are accepted. This allows
//    external agents to call the RFS / canvas-agent APIs without knowing
//    the Basic Auth credentials.
//
// CORS preflight (OPTIONS) always passes through unauthenticated.

const basicAuthUser = process.env.HUABU_BASIC_AUTH_USER;
const basicAuthPass = process.env.HUABU_BASIC_AUTH_PASS;
if (basicAuthUser && basicAuthPass) {
  const expectedBasic =
    'Basic ' +
    Buffer.from(`${basicAuthUser}:${basicAuthPass}`, 'utf8').toString('base64');
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const authHeader = request.headers.authorization || '';

    // Basic Auth (browser / Vite proxy)
    if (authHeader === expectedBasic) return;

    // Bearer token (agentlet RFS)
    if (authHeader.startsWith('Bearer ')) {
      const daemonToken = getDaemonAuth().getToken();
      if (daemonToken && authHeader.slice(7) === daemonToken) return;
    }

    reply
      .header('WWW-Authenticate', 'Basic realm="Sediment"')
      .status(401)
      .send({ message: 'Authentication required' });
  });
  app.log.info('HTTP Auth enabled (Basic + Bearer)');
} else {
  // No Basic Auth configured — still gate Bearer-only RFS routes
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    // Without Basic Auth, all routes are open EXCEPT the Bearer-only
    // RFS routes, which always require a valid Bearer token.
    if (!request.url.startsWith('/api/rfs/')) {
      return;
    }
    const authHeader = request.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
      const daemonToken = getDaemonAuth().getToken();
      if (daemonToken && authHeader.slice(7) === daemonToken) return;
    }
    reply.status(401).send({ message: 'Authentication required' });
  });
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
app.register(externalNoteRoutes, { prefix: '/api/canvas' });
app.register(syncRoutes, { prefix: '/api/canvas' });
app.register(webRoutes, { prefix: '/api/web' });
app.register(artifactRoute, { prefix: '/api/canvas' });

app.register(intentRoutes, { prefix: '/api/intent' });
app.register(llmRoutes, { prefix: '/api/llm' });
app.register(skillsRoutes, { prefix: '/api/skills' });
app.register(workspaceRoutes, { prefix: '/api/workspace' });
app.register(rfsRoutes, { prefix: '/api/rfs' });

// ── External agent (ACP) bridge ───────────────────────────────────────
// Mount @agentlet/server in daemon mode: an embedded supervisor
// (`DaemonSupervisor`) forks `agentlet daemon …` as a child process
// and connects it to this Fastify server via WebSocket loopback. The
// daemon owns the agent worker pool; the server tells it which agent
// CLI to spawn (per user profile). The daemon token never crosses the
// HTTP boundary — it lives only in-process and on the loopback WS.
//
// Legacy migration: older builds persisted an `enabled` flag + shared
// token in `data/acp-config.json`. The file is no longer read; if it
// exists we silently delete it so a stale 0600 file does not linger.
// The daemon supervisor also drops `data/acp-tickets.json` on attach.
try {
  const legacyAcpConfigPath = join(getDataDir(), 'acp-config.json');
  unlinkSync(legacyAcpConfigPath);
  app.log.info(
    `[acp] removed legacy ${legacyAcpConfigPath} \u2014 pairing is now daemon-managed`,
  );
} catch (err) {
  // ENOENT is the happy path (no legacy file to remove); anything else
  // is non-fatal — the bridge does not depend on the file.
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    app.log.warn({ err }, '[acp] could not remove legacy acp-config.json');
  }
}
mountAgentletServer(app);
getDaemonSupervisor().attach(app);
app.register(acpProfilesRoutes, { prefix: '/api/acp' });
app.register(acpAgentletRoutes, { prefix: '/api/acp' });
app.register(acpAgentCliRoutes, { prefix: '/api/acp' });
app.register(acpThreadsRoutes, { prefix: '/api/acp' });
app.log.info(
  '[acp] agentlet server mounted — embedded agentlet will start on server ready',
);

// Memory op-counter: bump the per-canvas counter on every successful
// mutating HTTP request scoped to a canvas. Registered last so all
// route handlers are already in place. See
// `modules/agent/memory/op-counter-hook.ts` for the policy details
// (which URLs are skipped, how the weight is derived).
registerOpCounterHook(app);

// ── Electron / production: serve pre-built web assets ─────────────────
// When WEB_DIST_PATH is set (injected by the Electron main process at
// startup), Fastify serves the compiled web SPA from that directory.
// All non-/api paths fall back to index.html so React Router works.
// In dev mode and standalone-server deployments this block is skipped
// entirely — no behaviour change.
const webDistPath = process.env.WEB_DIST_PATH;
if (webDistPath) {
  app.register(staticPlugin, {
    root: webDistPath,
    prefix: '/',
    decorateReply: false,
  });
  app.setNotFoundHandler((_request, reply) => {
    void reply.sendFile('index.html', webDistPath);
  });
  app.log.info(`[web] serving static assets from ${webDistPath}`);
}
