import { tmpdir } from 'node:os';

import compress from '@fastify/compress';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import agentRoutes from './modules/agent/agent.route.js';
import intentRoutes from './modules/agent/intent.route.js';
import llmRoutes from './modules/agent/llm.route.js';
import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import webRoutes from './modules/web/web.route.js';
import { isWorkspaceConfigured } from './modules/workspace.js';
import workspaceRoutes from './modules/workspace.route.js';

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
app.register(artifactRoute, { prefix: '/api' });

app.register(intentRoutes, { prefix: '/api/intent' });
app.register(llmRoutes, { prefix: '/api' });
app.register(workspaceRoutes, { prefix: '/api' });
