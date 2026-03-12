import { z } from 'zod';

import { ensureDefaultCanvas } from './canvas/canvas.filestore.js';
import {
  resetKnowledgeRepository,
  resetIngestService,
} from './knowledge/index.js';
import { getWorkspacePath, setWorkspacePath } from './workspace.js';

import type { FastifyPluginAsync } from 'fastify';

const workspaceRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/workspace – return current workspace path
  app.get('/workspace', async () => {
    return { path: getWorkspacePath() };
  });

  // PUT /api/workspace – update workspace path.
  // Restricted to requests originating from localhost: this server is a
  // local-only process and we do not want LAN peers to be able to redirect
  // storage to an arbitrary path on the user's machine.
  app.put('/workspace', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      return reply.status(403).send({
        message:
          'Forbidden: workspace settings can only be changed from localhost',
      });
    }

    const schema = z.object({
      path: z.string().min(1, 'Workspace path is required'),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message });
    }

    setWorkspacePath(parsed.data.path);
    // Reset knowledge singletons so they re-initialise against the new path
    resetKnowledgeRepository();
    resetIngestService();
    // Ensure a default canvas file exists in the new workspace
    ensureDefaultCanvas();
    return { path: getWorkspacePath() };
  });
};

export default workspaceRoutes;
