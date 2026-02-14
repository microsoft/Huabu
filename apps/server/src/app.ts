import { mkdir } from 'node:fs/promises';

import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import artifactRoute from './modules/artifact/artifact.route.js';
import { getArtifactsDir } from './modules/artifact/utils.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import chatRoutes from './modules/chat/chat.route.js';
import knowledgeRoute from './modules/knowledge/knowledge.route.js';
import webRoutes from './modules/web/web.route.js';

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

// Register static file serving for artifacts
const artifactsDir = getArtifactsDir();
// Ensure artifacts directory exists
await mkdir(artifactsDir, { recursive: true });

app.register(staticPlugin, {
  root: artifactsDir,
  prefix: '/api/artifact/',
});

app.register(chatRoutes, { prefix: '/api/chat' });
app.register(canvasRoutes, { prefix: '/api/canvas' });
app.register(webRoutes, { prefix: '/api/web' });
app.register(artifactRoute, { prefix: '/api' });
app.register(knowledgeRoute, { prefix: '/api' });
