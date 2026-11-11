// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canvasCommitHttpQuerySchema,
  canvasContentOperationRequestSchema,
  deleteNodeParamsSchema,
  canvasOperationLookupParamsSchema,
  canvasOperationLookupQuerySchema,
  canvasOperationRequestSchema,
  canvasOperationSessionBodySchema,
  canvasOperationSnapshotSchema,
  canvasOperationSnapshotQuerySchema,
  recentCanvasConversationParamsSchema,
} from '@huabu/shared';

import { submitCanvasContentOperation } from './content.js';
import { withCanvasOperations } from './scope.js';
import { submitCanvasOperation } from './service.js';
import { getRequestIdentity } from '../../identity/request.js';
import { SpaceOperationError } from '../../storage/ports/operations.js';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

export function operationPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const identity = getRequestIdentity(request);
  if (!identity) {
    reply
      .code(401)
      .send({ code: 'IDENTITY_REQUIRED', message: 'Authentication required' });
    return null;
  }
  if (!identity.owner) {
    reply.code(403).send({
      code: 'ACCESS_REQUIRED',
      message: 'Structural collaboration currently requires the owner',
    });
    return null;
  }
  return identity.principal.principalId;
}

export function operationFailure(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof SpaceOperationError) {
    const status =
      error.code === 'session-forbidden'
        ? 403
        : error.code === 'commit-too-large'
          ? 413
          : error.code === 'invalid-commit' || error.code === 'replay-corrupt'
            ? 500
            : 409;
    if (status === 500)
      request.log.error({ err: error }, 'Operation integrity failure');
    return reply
      .code(status)
      .send({ code: error.code, message: error.message });
  }
  request.log.error({ err: error }, 'Operation storage outcome is uncertain');
  return reply.code(503).send({
    code: 'operation-outcome-unknown',
    message:
      'The operation outcome is unknown; resolve the original operation before retrying',
  });
}

const operationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    operationPrincipal(request, reply);
  });
  fastify.post('/:canvasId/sync/sessions', async (request, reply) => {
    const params = recentCanvasConversationParamsSchema.safeParse(
      request.params,
    );
    const body = canvasOperationSessionBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .code(400)
        .send({ message: 'Invalid operation session request' });
    const principalId = operationPrincipal(request, reply);
    if (!principalId) return;
    try {
      return await withCanvasOperations(params.data.canvasId, (operations) =>
        operations.createSession(principalId),
      );
    } catch (error) {
      return operationFailure(error, request, reply);
    }
  });
  fastify.post(
    '/:canvasId/nodes/:nodeId/content/operations',
    { bodyLimit: 1048576 },
    async (request, reply) => {
      const params = deleteNodeParamsSchema.safeParse(request.params);
      const body = canvasContentOperationRequestSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ message: 'Invalid content operation' });
      const principalId = operationPrincipal(request, reply);
      if (!principalId) return;
      const identity = getRequestIdentity(request);
      try {
        return await submitCanvasContentOperation({
          ...params.data,
          request: body.data,
          principalId,
          origin: { kind: identity?.principal.kind === 'bot' ? 'agent' : 'ui' },
        });
      } catch (error) {
        return operationFailure(error, request, reply);
      }
    },
  );
  fastify.post(
    '/:canvasId/operations',
    { bodyLimit: 1048576 },
    async (request, reply) => {
      const params = recentCanvasConversationParamsSchema.safeParse(
        request.params,
      );
      const body = canvasOperationRequestSchema.safeParse(request.body);
      if (!params.success || !body.success)
        return reply.code(400).send({ message: 'Invalid operation request' });
      const principalId = operationPrincipal(request, reply);
      if (!principalId) return;
      const identity = getRequestIdentity(request);
      try {
        return await submitCanvasOperation({
          canvasId: params.data.canvasId,
          request: body.data,
          principalId,
          origin: { kind: identity?.principal.kind === 'bot' ? 'agent' : 'ui' },
        });
      } catch (error) {
        return operationFailure(error, request, reply);
      }
    },
  );
  fastify.get('/:canvasId/operations/:operationId', async (request, reply) => {
    const params = canvasOperationLookupParamsSchema.safeParse(request.params);
    const query = canvasOperationLookupQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid operation lookup' });
    const principalId = operationPrincipal(request, reply);
    if (!principalId) return;
    try {
      return await withCanvasOperations(params.data.canvasId, (operations) =>
        operations.lookup({
          ...query.data,
          operationId: params.data.operationId,
          principalId,
        }),
      );
    } catch (error) {
      return operationFailure(error, request, reply);
    }
  });
  fastify.get('/:canvasId/sync/commits', async (request, reply) => {
    const params = recentCanvasConversationParamsSchema.safeParse(
      request.params,
    );
    const query = canvasCommitHttpQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid commit query' });
    try {
      return await withCanvasOperations(params.data.canvasId, (operations) =>
        operations.readCommits(query.data),
      );
    } catch (error) {
      return operationFailure(error, request, reply);
    }
  });
  fastify.get('/:canvasId/sync/snapshot', async (request, reply) => {
    const params = recentCanvasConversationParamsSchema.safeParse(
      request.params,
    );
    const query = canvasOperationSnapshotQuerySchema.safeParse(request.query);
    if (!params.success || !query.success)
      return reply.code(400).send({ message: 'Invalid snapshot request' });
    try {
      return await withCanvasOperations(
        params.data.canvasId,
        async (operations) => {
          const snapshot = await operations.readSnapshot();
          if (!snapshot)
            throw new SpaceOperationError(
              'collaboration-disabled',
              'This Space has no operation baseline',
            );
          const projected = canvasOperationSnapshotSchema.safeParse({
            canvasId: params.data.canvasId,
            version: snapshot.record.version,
            metadata: snapshot.metadata,
            state: snapshot.record.state,
          });
          if (!projected.success)
            throw new SpaceOperationError(
              'collaboration-disabled',
              'This Space cannot be represented by the root-node structural model',
            );
          return projected.data;
        },
      );
    } catch (error) {
      return operationFailure(error, request, reply);
    }
  });
};

export default operationRoutes;
