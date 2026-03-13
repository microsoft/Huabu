import { tmpdir } from 'node:os';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import artifactRoute from './modules/artifact/artifact.route.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import chatRoutes from './modules/chat/chat.route.js';
import intentRoutes from './modules/intent/intent.route.js';
import knowledgeRoute from './modules/knowledge/knowledge.route.js';
import researchRoutes from './modules/research/research.route.js';
import webRoutes from './modules/web/web.route.js';
import { isWorkspaceConfigured } from './modules/workspace.js';
import workspaceRoutes from './modules/workspace.route.js';

export const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  bodyLimit: 100 * 1024 * 1024, // 100MB for file uploads
});

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
    !url.startsWith('/api/workspace')
  ) {
    return reply.status(503).send({
      message:
        'Workspace has not been configured yet. Please set a workspace path first.',
    });
  }
});

app.register(chatRoutes, { prefix: '/api/chat' });
app.register(canvasRoutes, { prefix: '/api/canvas' });
app.register(webRoutes, { prefix: '/api/web' });
app.register(artifactRoute, { prefix: '/api' });
app.register(knowledgeRoute, { prefix: '/api' });
app.register(researchRoutes, { prefix: '/api/research' });

app.register(intentRoutes, { prefix: '/api/intent' });
app.register(workspaceRoutes, { prefix: '/api' });
