// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { workspaceCreateSchema, workspaceRenameSchema } from '@huabu/shared';

import { resetPreprocessDispatcher } from './preprocessing/index.js';
import { getStructuredStore, resetStorageCache } from './storage/index.js';
import {
  activateWorkspacePath,
  prepareWorkspacePath,
  WorkspaceActivationInProgressError,
  WorkspaceActivationTimeoutError,
} from './workspace-activation.js';
import {
  getWorkspaceHandle,
  isManagedMode,
  resolveWorkspacePath,
  updateActiveWorkspaceHandle,
} from './workspace.js';

import type { WorkspaceHandle } from './storage/index.js';
import type { ApiErrorBody, WorkspaceDescriptor } from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

const workspaceIdSchema = z.string().uuid();

function sendError(
  reply: FastifyReply,
  status: number,
  message: string,
  code?: string,
  details?: unknown,
): FastifyReply {
  const body: ApiErrorBody = {
    message,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
  return reply.status(status).send(body);
}

function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function rejectReadOnlyMutation(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  if (isManagedMode()) {
    return sendError(reply, 403, 'Workspace collection is read-only');
  }
  if (!isLocalhost(request.ip)) {
    return sendError(
      reply,
      403,
      'Forbidden: workspace settings can only be changed from localhost',
    );
  }
  return null;
}

function descriptor(workspace: WorkspaceHandle): WorkspaceDescriptor {
  const active = getWorkspaceHandle()?.workspaceId === workspace.workspaceId;
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    path: isManagedMode() ? null : workspace.workspacePath,
    active,
  };
}

function parseWorkspaceId(
  rawWorkspaceId: string,
  reply: FastifyReply,
): string | FastifyReply {
  const parsed = workspaceIdSchema.safeParse(rawWorkspaceId);
  if (!parsed.success) {
    return sendError(reply, 400, 'Invalid Workspace id');
  }
  return parsed.data;
}

function sendPreparationError(
  reply: FastifyReply,
  error: unknown,
): FastifyReply {
  if (error instanceof WorkspaceActivationTimeoutError) {
    return sendError(
      reply,
      504,
      error.message,
      'WORKSPACE_ACTIVATION_TIMEOUT',
      { seconds: error.timeoutSeconds },
    );
  }
  if (error instanceof WorkspaceActivationInProgressError) {
    return sendError(
      reply,
      409,
      error.message,
      'WORKSPACE_ACTIVATION_IN_PROGRESS',
    );
  }
  return sendError(reply, 400, (error as Error).message);
}

interface WorkspaceParams {
  workspaceId: string;
}

const workspacesRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async () =>
    getStructuredStore().workspaces().list().map(descriptor),
  );

  app.post('/', async (request, reply) => {
    const rejected = rejectReadOnlyMutation(request, reply);
    if (rejected) return rejected;

    const parsed = workspaceCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        parsed.error.issues[0]?.message ?? 'Invalid request body',
      );
    }

    try {
      const workspacePath = resolveWorkspacePath(parsed.data.path);
      const repository = getStructuredStore().workspaces();
      const existing = repository.getByPath(workspacePath);
      if (existing) {
        const workspace = parsed.data.name
          ? (repository.rename(existing.workspaceId, parsed.data.name) ??
            existing)
          : existing;
        updateActiveWorkspaceHandle(workspace);
        return reply.send(descriptor(workspace));
      }

      await prepareWorkspacePath(workspacePath);
      let workspace = repository.open(workspacePath);
      if (parsed.data.name) {
        workspace =
          repository.rename(workspace.workspaceId, parsed.data.name) ??
          workspace;
      }
      return reply.status(201).send(descriptor(workspace));
    } catch (error) {
      return sendPreparationError(reply, error);
    }
  });

  app.get<{ Params: WorkspaceParams }>(
    '/:workspaceId',
    async (request, reply) => {
      const parsedId = parseWorkspaceId(request.params.workspaceId, reply);
      if (typeof parsedId !== 'string') return parsedId;
      const workspace = getStructuredStore().workspaces().get(parsedId);
      if (!workspace) return sendError(reply, 404, 'Workspace not found');
      return reply.send(descriptor(workspace));
    },
  );

  app.post<{ Params: WorkspaceParams }>(
    '/:workspaceId/activate',
    async (request, reply) => {
      const rejected = rejectReadOnlyMutation(request, reply);
      if (rejected) return rejected;
      const parsedId = parseWorkspaceId(request.params.workspaceId, reply);
      if (typeof parsedId !== 'string') return parsedId;

      const workspace = getStructuredStore().workspaces().get(parsedId);
      if (!workspace) return sendError(reply, 404, 'Workspace not found');
      try {
        await activateWorkspacePath(workspace.workspacePath);
        resetStorageCache();
        resetPreprocessDispatcher();
        return reply.send(descriptor(getWorkspaceHandle() ?? workspace));
      } catch (error) {
        return sendPreparationError(reply, error);
      }
    },
  );

  app.patch<{ Params: WorkspaceParams }>(
    '/:workspaceId',
    async (request, reply) => {
      const rejected = rejectReadOnlyMutation(request, reply);
      if (rejected) return rejected;
      const parsedId = parseWorkspaceId(request.params.workspaceId, reply);
      if (typeof parsedId !== 'string') return parsedId;
      const parsed = workspaceRenameSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(
          reply,
          400,
          parsed.error.issues[0]?.message ?? 'Invalid request body',
        );
      }

      try {
        const workspace = getStructuredStore()
          .workspaces()
          .rename(parsedId, parsed.data.name);
        if (!workspace) return sendError(reply, 404, 'Workspace not found');
        updateActiveWorkspaceHandle(workspace);
        return reply.send(descriptor(workspace));
      } catch (error) {
        return sendError(reply, 400, (error as Error).message);
      }
    },
  );

  app.delete<{ Params: WorkspaceParams }>(
    '/:workspaceId',
    async (request, reply) => {
      const rejected = rejectReadOnlyMutation(request, reply);
      if (rejected) return rejected;
      const parsedId = parseWorkspaceId(request.params.workspaceId, reply);
      if (typeof parsedId !== 'string') return parsedId;
      if (getWorkspaceHandle()?.workspaceId === parsedId) {
        return sendError(reply, 409, 'Cannot unregister the active Workspace');
      }
      if (!getStructuredStore().workspaces().remove(parsedId)) {
        return sendError(reply, 404, 'Workspace not found');
      }
      return reply.status(204).send();
    },
  );
};

export default workspacesRoutes;
