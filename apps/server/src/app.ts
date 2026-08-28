// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify, type FastifyBaseLogger } from 'fastify';

import { getConnectionToken } from './connection-token.js';
import { getDataDir } from './data-dir.js';
import { setHostServerPort } from './host-port.js';
import {
  acpAgentCliRoutes,
  acpAgentletRoutes,
  acpProfilesRoutes,
  acpThreadsRoutes,
  externalAgentRuntimeConfigRoutes,
  getAgentTeamRegistry,
  getSupervisedAgentletId,
  installAcpProfileCachePort,
  mountAgenetes,
  resolveDaemonEntry,
} from './modules/agent/acp/index.js';
import { buildLegacyCommandProfiles } from './modules/agent/acp/legacy-profile-migration.js';
import {
  listProfiles as listLegacyAcpProfiles,
  removeProfiles as removeLegacyAcpProfiles,
} from './modules/agent/acp/profile-store.js';
import agentRoutes from './modules/agent/agent.route.js';
import llmRoutes from './modules/agent/llm.route.js';
import { registerOpCounterHook } from './modules/agent/memory/op-counter-hook.js';
import skillsRoutes from './modules/agent/skills.route.js';
import agentTeamRoutes from './modules/agent-team/agent-team.route.js';
import {
  registerBundledAgentTeams,
  resolveBundledAgentTeamsPath,
} from './modules/agent-team/bundled-agent-teams.js';
import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import { resetExternalNoteSessions } from './modules/canvas/external-watcher.js';
import externalNoteRoutes from './modules/canvas/external.route.js';
import syncRoutes from './modules/canvas/sync.route.js';
import integrationsRoutes from './modules/integrations/integrations.route.js';
import interactiveViewRoutes from './modules/interactive-view/interactive-view.route.js';
import { isPublicRfsSkillBootstrapRequest } from './modules/remote_fs/public-skill.js';
import rfsRoutes from './modules/remote_fs/rfs.route.js';
import deploymentRoutes from './modules/security/deployment.route.js';
import {
  hostGuardPlugin,
  markBasicAuthenticated,
  originGuardPlugin,
  resolveAllowedHostnames,
} from './modules/security/index.js';
import webRoutes from './modules/web/web.route.js';
import {
  initWorkspaceFromEnv,
  isWorkspaceConfigured,
} from './modules/workspace.js';
import workspaceRoutes from './modules/workspace.route.js';
import workspacesRoutes from './modules/workspaces.route.js';
import { preloadSkills } from './prompt/index.js';
import { getPersistedSecret, setSecrets } from './security/secret-store.js';
import { MAX_UPLOAD_BYTES } from './upload-limits.js';
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
  bodyLimit: MAX_UPLOAD_BYTES, // large enough for canvas bundle imports
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
// `http://localhost:5173` (Vite dev) and `https://huabu.example`
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

// Register multipart for file uploads.
// The file-size ceiling is shared with `bodyLimit` above and tunable via
// `HUABU_MAX_UPLOAD_BYTES`; canvas imports bundle their `.artifacts/` dir
// and can be large.
app.register(multipart, {
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
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
    if (
      isPublicRfsSkillBootstrapRequest({
        method: request.method,
        url: request.url,
        authorization: authHeader || undefined,
      })
    ) {
      return;
    }

    // Basic Auth (browser / Vite proxy)
    if (authHeader === expectedBasic) {
      markBasicAuthenticated(request);
      return;
    }

    // Bearer token (agentlet RFS)
    if (authHeader.startsWith('Bearer ')) {
      const daemonToken = getConnectionToken();
      if (daemonToken && authHeader.slice(7) === daemonToken) return;
    }

    reply
      .header('WWW-Authenticate', 'Basic realm="Huabu"')
      .status(401)
      .send({ message: 'Authentication required' });
  });
  app.log.info('HTTP Auth enabled (Basic + Bearer)');
} else {
  // No Basic Auth configured — still gate Bearer-only RFS routes
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') return;
    const authHeader = request.headers.authorization || '';
    if (
      isPublicRfsSkillBootstrapRequest({
        method: request.method,
        url: request.url,
        authorization: authHeader || undefined,
      })
    ) {
      return;
    }
    // Without Basic Auth, all routes are open EXCEPT the Bearer-only
    // RFS routes, which always require a valid Bearer token.
    if (!request.url.startsWith('/api/rfs/')) {
      return;
    }
    if (authHeader.startsWith('Bearer ')) {
      const daemonToken = getConnectionToken();
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
  const publicSkillBootstrap = isPublicRfsSkillBootstrapRequest({
    method: request.method,
    url,
    authorization: request.headers.authorization,
  });
  if (
    !isWorkspaceConfigured() &&
    url.startsWith('/api') &&
    !publicSkillBootstrap &&
    !url.startsWith('/api/workspace') &&
    !url.startsWith('/api/deployment') &&
    !url.startsWith('/api/llm') &&
    !url.startsWith('/api/integrations')
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

app.register(llmRoutes, { prefix: '/api/llm' });
app.register(integrationsRoutes, { prefix: '/api/integrations' });
app.register(deploymentRoutes, { prefix: '/api/deployment' });
app.register(interactiveViewRoutes, { prefix: '/api/interactive-views' });
app.register(skillsRoutes, { prefix: '/api/skills' });
app.register(workspaceRoutes, { prefix: '/api/workspace' });
app.register(workspacesRoutes, { prefix: '/api/workspaces' });
app.register(rfsRoutes, { prefix: '/api/rfs' });
app.register(agentTeamRoutes, { prefix: '/api/agent-team' });

// ── External agent (ACP) transport host ───────────────────────────────
// Mount the Agenetes agentlet transport host (`@agenetes/agentlet-host`).
// It mounts the stateless Gateway, forks & supervises the agentlet daemon,
// and authenticates connections against the host-injected connection token.
// The daemon owns the agent worker pool; the server tells it which agent CLI
// to spawn (per user profile). The connection token never crosses the HTTP
// boundary — it lives only in-process and on the loopback WS.
//
// L1 owns all deployment-layout knowledge and injects it downward:
// the global connection token, the data directory, and the resolved
// absolute daemon entry path.
//
// Legacy migration: older builds persisted an `enabled` flag + shared
// token in `data/acp-config.json`. The file is no longer read; if it
// exists we silently delete it so a stale 0600 file does not linger.
// The transport host also drops `data/acp-tickets.json` on attach.
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
const agentletGateway = mountAgenetes(app, {
  connectionToken: getConnectionToken(),
  dataDir: getDataDir(),
  daemonEntryPath: resolveDaemonEntry() ?? '',
  // Host-namespaced env isolation: the agentlet daemon and every external
  // agent it spawns are host-agnostic and must receive their Huabu
  // coordinates only through explicit injection (per-agent reachback env),
  // never through ambient inheritance. Strip the entire `HUABU_` namespace
  // from the forked daemon's environment (empty allowlist — the daemon
  // needs none of it) so host secrets like `HUABU_SECRET_KEY` and unrelated
  // host config never leak into untrusted agent processes. See
  // docs/architecture/agent-reachback.md ("Environment injection and isolation").
  hostEnvPrefix: 'HUABU_',
  hostEnvAllowlist: [],
  agentTeam: {
    storageDir: join(getDataDir(), 'agent-team'),
    secretStore: {
      get: getPersistedSecret,
      setMany: setSecrets,
    },
    legacyCommandProfiles: buildLegacyCommandProfiles(
      listLegacyAcpProfiles(),
      getSupervisedAgentletId(),
      process.cwd(),
    ),
    onLegacyProfilesMigrated: removeLegacyAcpProfiles,
  },
});
// Legacy `agent-team` ACP records predate managed Agent Teams. They can't
// be auto-migrated (they bypass managed roots, Configs, and setup) and are
// no longer surfaced in Settings, so drop them at startup instead of
// letting them linger as orphaned entries.
removeLegacyAcpProfiles(
  listLegacyAcpProfiles()
    .filter((profile) => profile.cliId === 'agent-team')
    .map((profile) => profile.id),
);
const bundledAgentTeamsPath = resolveBundledAgentTeamsPath();
if (bundledAgentTeamsPath) {
  const unregisterBundledAgentTeams = registerBundledAgentTeams({
    bundledRootPath: bundledAgentTeamsPath,
    localMachine: getSupervisedAgentletId(),
    machineSource: agentletGateway,
    getRegistry: getAgentTeamRegistry,
    log: app.log,
  });
  app.addHook('onClose', async () => unregisterBundledAgentTeams());
} else {
  app.log.warn('[agent-team] bundled collection not found');
}
// Release every active external-note session on shutdown. Their `fs.watch`
// handles are otherwise only closed on a workspace switch, so a
// force-terminated process leaves them open — and on virtual/network
// filesystems (Google Drive) an abandoned watch request can stay wedged
// after the process is gone. Closing them here lets `app.close()` (driven
// by the SIGTERM/SIGINT handlers in server.ts) tear them down gracefully.
app.addHook('onClose', async () => resetExternalNoteSessions());
// Capture the bound TCP port for L1-owned reachback (RFS): the
// canvas-scoped `HUABU_RFS_URL` base is built from this. RFS is
// canvas-coupled and therefore a pure L1 concern, so the port lives in
// L1 rather than being read back out of the L2 transport host.
app.addHook('onListen', async () => {
  const addr = app.server.address();
  if (addr && typeof addr !== 'string') setHostServerPort(addr.port);
});
// Inject the L1-owned profile-schema-cache port into the ACP composition
// shell so out-of-turn meta pushes feed the cache without L2 importing it
// (M3). See modules/agent/acp/profile-cache-port.ts.
installAcpProfileCachePort();
app.register(acpProfilesRoutes, { prefix: '/api/acp' });
app.register(acpAgentletRoutes, { prefix: '/api/acp' });
app.register(acpAgentCliRoutes, { prefix: '/api/acp' });
app.register(acpThreadsRoutes, { prefix: '/api/acp' });
app.register(externalAgentRuntimeConfigRoutes, { prefix: '/api/acp' });
app.log.info(
  '[acp] agentlet Gateway mounted — embedded agentlet will start on server ready',
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
