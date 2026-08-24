// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { z } from 'zod';

import { workspaceCreateSchema, workspaceRenameSchema } from '@huabu/shared';

import { resetPreprocessDispatcher } from './preprocessing/index.js';
import {
  adoptWorkspaceDirectory,
  getWorkspaceRepository,
  resetStorageCache,
  workspaceAtDirectory,
  workspaceDirectory,
} from './storage/index.js';
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
import type {
  ApiErrorBody,
  WorkspaceCreateRequest,
  WorkspaceDescriptor,
  WorkspaceRenameRequest,
} from '@huabu/shared';
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
    // A Workspace's directory is a materialization fact the handle does not
    // carry, so it is resolved separately — and never sent in managed mode.
    path: isManagedMode() ? null : workspaceDirectory(workspace.workspaceId),
    active,
  };
}

/**
 * The Workspaces this deployment may talk about.
 *
 * Managed mode locks its Workspace at boot, so every other registration in the
 * data directory — a free-mode session that used the same one, say — is
 * unaddressable here: activation is refused and paths are redacted. Listing
 * those would leak nothing but the host folder names of Workspaces this
 * deployment cannot reach, which is the very thing path redaction exists to
 * prevent. Managed mode therefore sees exactly one Workspace: the active one.
 */
function visibleWorkspaces(): readonly WorkspaceHandle[] {
  if (!isManagedMode()) return getWorkspaceRepository().list();
  const active = getWorkspaceHandle();
  return active ? [active] : [];
}

function findVisible(workspaceId: string): WorkspaceHandle | null {
  if (!isManagedMode()) return getWorkspaceRepository().get(workspaceId);
  const active = getWorkspaceHandle();
  return active?.workspaceId === workspaceId ? active : null;
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
  app.get('/', async () => visibleWorkspaces().map(descriptor));

  app.post<{ Body: WorkspaceCreateRequest }>('/', async (request, reply) => {
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
      const repository = getWorkspaceRepository();
      const existing = workspaceAtDirectory(workspacePath);
      if (existing) {
        if (!parsed.data.name) return reply.send(descriptor(existing));
        const renamed =
          repository.rename(existing.workspaceId, parsed.data.name) ?? existing;
        updateActiveWorkspaceHandle(renamed);
        return reply.send(descriptor(renamed));
      }

      await prepareWorkspacePath(workspacePath);
      let workspace = adoptWorkspaceDirectory(workspacePath);
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
      const workspace = findVisible(parsedId);
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

      const workspace = getWorkspaceRepository().get(parsedId);
      const workspacePath = workspaceDirectory(parsedId);
      if (!workspace || !workspacePath) {
        return sendError(reply, 404, 'Workspace not found');
      }
      try {
        await activateWorkspacePath(workspacePath);
        resetStorageCache();
        resetPreprocessDispatcher();
        return reply.send(descriptor(getWorkspaceHandle() ?? workspace));
      } catch (error) {
        return sendPreparationError(reply, error);
      }
    },
  );

  app.patch<{ Params: WorkspaceParams; Body: WorkspaceRenameRequest }>(
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
        const workspace = getWorkspaceRepository().rename(
          parsedId,
          parsed.data.name,
        );
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
      // Deliberately not gated on the Workspace being readable: unregistering
      // a folder that has since been deleted or unmounted is exactly when
      // this is needed, and it only ever removes the index entry.
      if (!getWorkspaceRepository().remove(parsedId)) {
        return sendError(reply, 404, 'Workspace not found');
      }
      return reply.status(204).send();
    },
  );
};

export default workspacesRoutes;
