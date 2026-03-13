import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { fastify } from 'fastify';

import artifactRoute from './modules/artifact/artifact.route.js';
import { ensureDefaultCanvas } from './modules/canvas/canvas.filestore.js';
import canvasRoutes from './modules/canvas/canvas.route.js';
import chatRoutes from './modules/chat/chat.route.js';
import intentRoutes from './modules/intent/intent.route.js';
import knowledgeRoute from './modules/knowledge/knowledge.route.js';
import researchRoutes from './modules/research/research.route.js';
import webRoutes from './modules/web/web.route.js';
import { ensureWorkspaceDirs, getArtifactsDir } from './modules/workspace.js';
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

// Register static file serving for artifacts
// Ensure workspace directories exist (canvas, sources, artifacts)
try {
  ensureWorkspaceDirs();
  ensureDefaultCanvas();
} catch (err) {
  console.error(
    '[startup] Failed to create workspace directories. ' +
      'Check that the path is writable and that SEDIMENT_WORKSPACE_PATH (if set) is valid.',
    err,
  );
  process.exit(1);
}
const artifactsDir = getArtifactsDir();

app.register(staticPlugin, {
  root: artifactsDir,
  prefix: '/api/artifact/',
});

app.register(chatRoutes, { prefix: '/api/chat' });
app.register(canvasRoutes, { prefix: '/api/canvas' });
app.register(webRoutes, { prefix: '/api/web' });
app.register(artifactRoute, { prefix: '/api' });
app.register(knowledgeRoute, { prefix: '/api' });
app.register(researchRoutes, { prefix: '/api/research' });

app.register(intentRoutes, { prefix: '/api/intent' });
app.register(workspaceRoutes, { prefix: '/api' });
