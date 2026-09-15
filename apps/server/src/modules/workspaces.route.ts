// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import path from 'node:path';

import { z } from 'zod';

import { workspaceCreateSchema, workspaceRenameSchema } from '@huabu/shared';

import { migrateLegacyDesktopWorkspaceStore } from './legacy-desktop-workspace-store.js';
import { resetPreprocessDispatcher } from './preprocessing/index.js';
import {
  activateWorkspace,
  adoptWorkspaceDirectory,
  createNamedWorkspace,
  ensureWorkspaceManifestOnDisk,
  getWorkspaceRepository,
  hasWorkspaceRegistry,
  materializesWorkspaces,
  resetStorageCache,
  workspaceAtDirectory,
  workspaceDirectory,
  workspaceIdentityOnDisk,
} from './storage/index.js';
import {
  activateWorkspacePath,
  prepareWorkspacePath,
  WorkspaceActivationInProgressError,
  WorkspaceActivationTimeoutError,
} from './workspace-activation.js';
import {
  commitWorkspacePath,
  getWorkspaceDirectory,
  getWorkspaceHandle,
  getWorkspacePath,
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
  const workspacePath = workspaceDirectory(workspace.workspaceId);
  const activeHandle = getWorkspaceHandle();
  const activeDirectory = getWorkspaceDirectory();
  // Identity decides which Workspace is active. On Disk the location has to
  // agree as well, because a registered id can be pointed at a folder the
  // process is not the one serving; where there is no folder, there is
  // nothing else to agree.
  const active =
    activeHandle?.workspaceId === workspace.workspaceId &&
    (workspacePath === null || activeDirectory === null
      ? !materializesWorkspaces()
      : path.resolve(activeDirectory) === path.resolve(workspacePath));
  return {
    workspaceId: workspace.workspaceId,
    name: workspace.name,
    // A Workspace's directory is a materialization fact the handle does not
    // carry, so it is resolved separately — and never sent in managed mode.
    path: isManagedMode() ? null : workspacePath,
    active,
  };
}

/** Follow an externally moved active Disk Workspace before publishing it. */
function reconcileActiveWorkspaceLocation(
  workspace: WorkspaceHandle,
  workspacePath: string,
): WorkspaceHandle {
  if (getWorkspaceHandle()?.workspaceId !== workspace.workspaceId) {
    return workspace;
  }
  if (path.resolve(getWorkspacePath()) === path.resolve(workspacePath)) {
    return workspace;
  }
  commitWorkspacePath(workspacePath);
  return getWorkspaceHandle() ?? workspace;
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
async function visibleWorkspaces(): Promise<readonly WorkspaceHandle[]> {
  if (!isManagedMode()) return await getWorkspaceRepository().list();
  const active = getWorkspaceHandle();
  return active ? [active] : [];
}

async function findVisible(
  workspaceId: string,
): Promise<WorkspaceHandle | null> {
  if (!isManagedMode()) return await getWorkspaceRepository().get(workspaceId);
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
  let legacyDesktopStoreImported = false;

  /**
   * Import the deprecated desktop store once, before the first plural request
   * is answered. Registration-only and synchronous, so it costs the triggering
   * request a stat per remembered folder rather than holding the collection
   * behind a preparation fork each.
   */
  function importLegacyDesktopStore(): void {
    if (
      legacyDesktopStoreImported ||
      isManagedMode() ||
      // The deprecated store remembers folders, so there is nothing to import
      // where a Workspace is not one.
      !materializesWorkspaces() ||
      hasWorkspaceRegistry()
    )
      return;
    const filePath = process.env.HUABU_LEGACY_WORKSPACE_STORE?.trim();
    if (!filePath) return;
    // Mark before running: an import that throws is an import that happened,
    // and retrying it on every later request would only repeat the failure.
    legacyDesktopStoreImported = true;
    migrateLegacyDesktopWorkspaceStore(filePath, {
      hasWorkspaceRegistry,
      adoptWorkspaceDirectory,
      workspaceIdentityOnDisk,
    });
  }

  app.addHook('preHandler', async () => {
    importLegacyDesktopStore();
  });

  app.get('/', async () => (await visibleWorkspaces()).map(descriptor));

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

    // A Workspace that is a row is created by name: there is no folder to
    // adopt, prepare, or fork a child process for. The deployment still holds
    // as many Workspaces as it likes — this is the only one of the collection
    // operations the folder API could not already express.
    if (!materializesWorkspaces()) {
      const name = parsed.data.name;
      if (!name) {
        return sendError(reply, 400, 'Workspace name is required');
      }
      try {
        return reply
          .status(201)
          .send(descriptor(await createNamedWorkspace(name)));
      } catch (error) {
        return sendPreparationError(reply, error);
      }
    }

    const requestedPath = parsed.data.path;
    if (!requestedPath) {
      return sendError(reply, 400, 'Workspace path is required');
    }

    try {
      const workspacePath = resolveWorkspacePath(requestedPath);
      const repository = getWorkspaceRepository();
      const existing = workspaceAtDirectory(workspacePath);
      if (existing) {
        const current = reconcileActiveWorkspaceLocation(
          existing,
          workspacePath,
        );
        if (!parsed.data.name) return reply.send(descriptor(current));
        const renamed =
          (await repository.rename(existing.workspaceId, parsed.data.name)) ??
          current;
        updateActiveWorkspaceHandle(renamed);
        return reply.send(descriptor(renamed));
      }

      await prepareWorkspacePath(workspacePath);
      const preparedManifest = ensureWorkspaceManifestOnDisk(workspacePath);
      const preparedWorkspace = {
        workspaceId: preparedManifest.workspaceId,
        name: preparedManifest.name,
      };
      let workspace: WorkspaceHandle;
      if (getWorkspaceHandle()?.workspaceId === preparedWorkspace.workspaceId) {
        // `existing` was null, so even a same-path active Workspace needs its
        // missing membership repaired. Committing adopts it and keeps active
        // identity and materialization on one location.
        commitWorkspacePath(workspacePath);
        workspace = getWorkspaceHandle() ?? preparedWorkspace;
      } else {
        workspace = adoptWorkspaceDirectory(workspacePath);
      }
      if (parsed.data.name) {
        workspace =
          (await repository.rename(workspace.workspaceId, parsed.data.name)) ??
          workspace;
        updateActiveWorkspaceHandle(workspace);
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
      const workspace = await findVisible(parsedId);
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

      const workspace = await getWorkspaceRepository().get(parsedId);
      if (!workspace) return sendError(reply, 404, 'Workspace not found');

      // A Workspace that is a row needs no preparation: activation is
      // re-scoping the connection, which is why this profile can switch
      // Workspaces without a folder to prepare or a child process to fork.
      if (!materializesWorkspaces()) {
        try {
          await activateWorkspace(workspace);
          resetPreprocessDispatcher();
          return reply.send(descriptor(getWorkspaceHandle() ?? workspace));
        } catch (error) {
          return sendPreparationError(reply, error);
        }
      }

      const workspacePath = workspaceDirectory(parsedId);
      if (!workspacePath) return sendError(reply, 404, 'Workspace not found');
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
        const workspace = await getWorkspaceRepository().rename(
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
      if (!(await getWorkspaceRepository().remove(parsedId))) {
        return sendError(reply, 404, 'Workspace not found');
      }
      return reply.status(204).send();
    },
  );
};

export default workspacesRoutes;
