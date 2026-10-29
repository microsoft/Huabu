// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { isPublicRfsSkillBootstrapRequest } from './remote_fs/public-skill.js';
import { isWorkspaceConfigured } from './workspace.js';

import type { FastifyInstance } from 'fastify';

/**
 * Reject requests to non-workspace routes while no Workspace is configured.
 * The routes that configure one, and those that sign a caller in, stay open.
 */
export function registerWorkspaceRequiredGuard(app: FastifyInstance): void {
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
      // Signing in and out must work before a Workspace exists: a Bubble
      // owner needs a session to reach Workspace setup.
      !['/api/identity', '/api/identity/session'].includes(
        url.split('?', 1)[0],
      ) &&
      !url.startsWith('/api/llm') &&
      !url.startsWith('/api/integrations') &&
      !url.startsWith('/api/services')
    ) {
      return reply.status(503).send({
        message:
          'Workspace has not been configured yet. Please set a workspace path first.',
      });
    }
  });
}
