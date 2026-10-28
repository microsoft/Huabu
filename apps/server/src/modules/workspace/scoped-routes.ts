// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { fillWorkspaceScope, openWorkspaceScope } from './context.js';
import { getWorkspaceRepository, openWorkspace } from '../storage/index.js';

import type { FastifyPluginAsync } from 'fastify';

/**
 * Serve `routes` under a `:workspaceId` prefix, each call running in that
 * Workspace whatever the caller's current one or the process-active one is.
 *
 * For callers whose Workspace was fixed when they started: an agent run keeps
 * the Workspace it was launched in for its whole life, so its reachback names
 * it rather than following its starter's later switches.
 */
export function workspaceScopedRoutes(
  routes: FastifyPluginAsync,
): FastifyPluginAsync {
  return async (app) => {
    // Own slot, wrapping the rest of the lifecycle; admission's, if any, was
    // for the caller's current Workspace and does not apply here.
    app.addHook('onRequest', (_request, _reply, done) =>
      openWorkspaceScope(done),
    );
    app.addHook('onRequest', async (request, reply) => {
      const { workspaceId } = request.params as { workspaceId?: string };
      const workspace = workspaceId
        ? await getWorkspaceRepository().get(workspaceId)
        : null;
      if (!workspace)
        return reply.code(404).send({ message: 'Workspace not found' });
      fillWorkspaceScope(await openWorkspace(workspace));
    });
    await app.register(routes);
  };
}
