import {
  AgentletRequestError,
  ResourceRegistryError,
  getAgentletGateway,
  getResourceRegistry,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import {
  agentResourceIdParamsSchema,
  importAgentResourceBodySchema,
  patchAgentResourceBodySchema,
  refreshAgentResourceBodySchema,
  scanAgentResourcesBodySchema,
} from '@huabu/shared';

import { isOwnerRequest } from '../../security/owner.js';

import type {
  AgentResourceIdParams,
  AgentResourceMutationResponse,
  ApiResult,
  ImportAgentResourceBody,
  PatchAgentResourceBody,
  RefreshAgentResourceBody,
  ScanAgentResourcesBody,
  ScanAgentResourcesResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function denyRemote(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isOwnerRequest(request)) return false;
  reply.status(403).send({
    message: 'Forbidden: agent resources can only be managed from localhost',
  });
  return true;
}

function requireRegistry(reply: FastifyReply) {
  const registry = getResourceRegistry();
  if (registry) return registry;
  reply.status(503).send({
    message: 'Agent Resource Registry is not ready',
    code: 'resource_registry_unavailable',
  });
  return null;
}

function requireGateway(reply: FastifyReply) {
  const gateway = getAgentletGateway();
  const agentletId = getSupervisedAgentletId();
  if (gateway?.getAgentlet(agentletId)?.status === 'connected') {
    return { gateway, agentletId };
  }
  reply.status(503).send({
    message: 'Agentlet is not connected',
    code: 'agentlet_unavailable',
  });
  return null;
}

function sendResourceError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof ResourceRegistryError) {
    return reply
      .status(error.code === 'resource_not_found' ? 404 : 409)
      .send({ message: error.message, code: error.code });
  }
  if (error instanceof AgentletRequestError) {
    const code =
      typeof error.data === 'object' &&
      error.data !== null &&
      'code' in error.data &&
      typeof error.data.code === 'string'
        ? error.data.code
        : 'agentlet_request_failed';
    return reply.status(400).send({ message: error.message, code });
  }
  throw error;
}

const agentResourceRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Body: ScanAgentResourcesBody;
    Reply: ApiResult<ScanAgentResourcesResponse>;
  }>('/resources/import/scan', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const parsed = scanAgentResourcesBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid scan body',
        code: 'validation_failed',
      });
    }
    const control = requireGateway(reply);
    if (!control) return;
    try {
      return await control.gateway.scanResources(
        control.agentletId,
        parsed.data,
      );
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });

  app.post<{
    Body: ImportAgentResourceBody;
    Reply: ApiResult<AgentResourceMutationResponse>;
  }>('/resources/import', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const parsed = importAgentResourceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid import body',
        code: 'validation_failed',
      });
    }
    const registry = requireRegistry(reply);
    const control = requireGateway(reply);
    if (!registry || !control) return;
    if (registry.get(parsed.data.id)) {
      return reply.status(409).send({
        message: `Resource is already registered: ${parsed.data.id}`,
        code: 'resource_conflict',
      });
    }

    try {
      const result = await control.gateway.importResource(control.agentletId, {
        id: parsed.data.id,
        sourcePath: parsed.data.sourcePath,
        expectedRevision: parsed.data.expectedRevision,
      });
      let resource;
      try {
        resource = registry.register({
          ...result.resource,
          ...(parsed.data.displayName
            ? { displayName: parsed.data.displayName }
            : {}),
          userContent: parsed.data.userContent,
        });
      } catch (registryError) {
        if (result.created) {
          try {
            await control.gateway.deleteResource(control.agentletId, {
              id: parsed.data.id,
            });
          } catch (cleanupError) {
            throw new Error(
              `Resource import failed and the managed copy could not be removed: ${
                cleanupError instanceof Error
                  ? cleanupError.message
                  : String(cleanupError)
              }`,
            );
          }
        }
        throw registryError;
      }
      return { resource };
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });

  app.patch<{
    Params: AgentResourceIdParams;
    Body: PatchAgentResourceBody;
    Reply: ApiResult<AgentResourceMutationResponse>;
  }>('/resources/:resourceId', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentResourceIdParamsSchema.safeParse(request.params);
    const body = patchAgentResourceBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const issue = !params.success
        ? params.error.issues[0]
        : !body.success
          ? body.error.issues[0]
          : undefined;
      return reply.status(400).send({
        message: issue?.message ?? 'Invalid resource patch',
        code: 'validation_failed',
      });
    }
    const registry = requireRegistry(reply);
    if (!registry) return;
    const current = registry.get(params.data.resourceId);
    if (!current) {
      return reply.status(404).send({
        message: `Resource not found: ${params.data.resourceId}`,
        code: 'resource_not_found',
      });
    }
    try {
      const resource = registry.replaceOwn(current.provider, {
        ...current,
        ...(body.data.displayName === undefined
          ? {}
          : body.data.displayName === null
            ? { displayName: undefined }
            : { displayName: body.data.displayName }),
        ...(body.data.userContent === undefined
          ? {}
          : { userContent: body.data.userContent }),
      });
      return { resource };
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });

  app.post<{
    Params: AgentResourceIdParams;
    Reply: ApiResult<ScanAgentResourcesResponse>;
  }>('/resources/:resourceId/refresh/scan', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentResourceIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        message: params.error.issues[0]?.message ?? 'Invalid resource id',
        code: 'validation_failed',
      });
    }
    const control = requireGateway(reply);
    if (!control) return;
    try {
      return await control.gateway.scanResourceRefresh(control.agentletId, {
        id: params.data.resourceId,
      });
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });

  app.post<{
    Params: AgentResourceIdParams;
    Body: RefreshAgentResourceBody;
    Reply: ApiResult<AgentResourceMutationResponse>;
  }>('/resources/:resourceId/refresh', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentResourceIdParamsSchema.safeParse(request.params);
    const body = refreshAgentResourceBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const issue = !params.success
        ? params.error.issues[0]
        : !body.success
          ? body.error.issues[0]
          : undefined;
      return reply.status(400).send({
        message: issue?.message ?? 'Invalid resource refresh',
        code: 'validation_failed',
      });
    }
    const registry = requireRegistry(reply);
    const control = requireGateway(reply);
    if (!registry || !control) return;
    const current = registry.get(params.data.resourceId);
    if (!current || current.provider !== control.agentletId) {
      return reply.status(404).send({
        message: `Imported Skill not found: ${params.data.resourceId}`,
        code: 'resource_not_found',
      });
    }
    try {
      const result = await control.gateway.refreshResource(control.agentletId, {
        id: params.data.resourceId,
        expectedRevision: body.data.expectedRevision,
      });
      const latest = registry.get(params.data.resourceId);
      if (!latest || latest.provider !== control.agentletId) {
        throw new ResourceRegistryError(
          'resource_not_found',
          `Resource not found after refresh: ${params.data.resourceId}`,
        );
      }
      let resource;
      try {
        resource = registry.replaceOwn(control.agentletId, {
          ...result.resource,
          ...(latest.displayName ? { displayName: latest.displayName } : {}),
          userContent: latest.userContent,
        });
      } catch {
        try {
          const providerResources = registry
            .list()
            .filter((item) => item.provider === control.agentletId)
            .map((item) =>
              item.id === result.resource.id ? result.resource : item,
            );
          resource = registry
            .replaceProviderResources(control.agentletId, providerResources)
            .find((item) => item.id === result.resource.id);
          if (!resource)
            throw new Error('Refreshed resource was not reconciled');
        } catch (reconciliationError) {
          throw new Error(
            `Resource refreshed locally but registry reconciliation failed: ${
              reconciliationError instanceof Error
                ? reconciliationError.message
                : String(reconciliationError)
            }`,
          );
        }
      }
      return { resource };
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });

  app.delete<{
    Params: AgentResourceIdParams;
    Reply: ApiResult<{ removed: boolean }>;
  }>('/resources/:resourceId', async (request, reply) => {
    if (denyRemote(request, reply)) return;
    const params = agentResourceIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        message: params.error.issues[0]?.message ?? 'Invalid resource id',
        code: 'validation_failed',
      });
    }
    const registry = requireRegistry(reply);
    const control = requireGateway(reply);
    if (!registry || !control) return;
    const current = registry.get(params.data.resourceId);
    if (!current || current.provider !== control.agentletId) {
      return reply.status(404).send({
        message: `Imported Skill not found: ${params.data.resourceId}`,
        code: 'resource_not_found',
      });
    }
    try {
      const result = await control.gateway.deleteResource(control.agentletId, {
        id: params.data.resourceId,
      });
      registry.withdraw(control.agentletId, params.data.resourceId);
      return { removed: result.removed || Boolean(current) };
    } catch (error) {
      return sendResourceError(error, reply);
    }
  });
};

export default agentResourceRoutes;
