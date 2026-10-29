// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  createChildSpaceBodySchema,
  deleteSpaceTreeBodySchema,
  spaceHierarchyParamsSchema,
  spaceParentBodySchema,
} from '@huabu/shared';

import {
  createChildSpace,
  deleteSpaceTree,
  deletionPreview,
  setSpaceParent,
  SpaceHierarchyError,
} from './space-hierarchy.js';
import { withSpaceHierarchyLock } from './write-coordinator.js';
import { claimSpace } from '../security/space-access.js';
import { getStructuredStore } from '../storage/index.js';

import type { FastifyInstance, FastifyReply } from 'fastify';

export function registerSpaceHierarchyRoutes(fastify: FastifyInstance): void {
  async function respond(
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) {
    try {
      return reply.send(await operation());
    } catch (error) {
      if (error instanceof SpaceHierarchyError) {
        if (error.status >= 500)
          fastify.log.error(
            { err: error, details: error.details },
            'Space hierarchy operation incomplete',
          );
        return reply.code(error.status).send({
          message: error.message,
          code: error.code,
          details: error.details,
        });
      }
      fastify.log.error({ err: error }, 'Space hierarchy operation failed');
      return reply.code(500).send({
        code: 'SPACE_HIERARCHY_FAILED',
        message: 'Space hierarchy operation failed',
      });
    }
  }

  fastify.post('/:canvasId/children', async (request, reply) => {
    const params = spaceHierarchyParamsSchema.safeParse(request.params);
    const body = createChildSpaceBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ message: 'Invalid child Space request' });
    // The creator owns the child, so detaching it later keeps it theirs.
    return respond(reply, async () => {
      try {
        const created = await createChildSpace(
          params.data.canvasId,
          body.data.title,
          body.data.position,
        );
        await claimSpace(request, created.canvasId);
        return created;
      } catch (error) {
        const details = (error as SpaceHierarchyError).details as
          | { canvasId?: unknown }
          | undefined;
        if (
          error instanceof SpaceHierarchyError &&
          typeof details?.canvasId === 'string'
        )
          await claimSpace(request, details.canvasId);
        throw error;
      }
    });
  });
  fastify.patch('/:canvasId/parent', async (request, reply) => {
    const params = spaceHierarchyParamsSchema.safeParse(request.params);
    const body = spaceParentBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply.code(400).send({ message: 'Invalid Space parent request' });
    return respond(reply, async () => {
      // A root Space inherits from no parent, so whoever detaches it keeps
      // it. The claim is made only for a valid, real detachment and before
      // it commits: until it holds, the Space stays under the parent the
      // caller reaches it through.
      return setSpaceParent(params.data.canvasId, body.data, undefined, () =>
        claimSpace(request, params.data.canvasId),
      );
    });
  });
  fastify.get('/:canvasId/deletion-preview', async (request, reply) => {
    const params = spaceHierarchyParamsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(400).send({ message: 'Invalid Space ID' });
    return respond(reply, () =>
      withSpaceHierarchyLock(async () =>
        deletionPreview(
          await getStructuredStore().spaces().list(),
          params.data.canvasId,
        ),
      ),
    );
  });
  fastify.post('/:canvasId/delete-tree', async (request, reply) => {
    const params = spaceHierarchyParamsSchema.safeParse(request.params);
    const body = deleteSpaceTreeBodySchema.safeParse(request.body);
    if (!params.success || !body.success)
      return reply
        .code(400)
        .send({ message: 'Invalid subtree deletion request' });
    return respond(reply, async () => ({
      deletedCanvasIds: await deleteSpaceTree(
        params.data.canvasId,
        body.data.token,
      ),
    }));
  });
}
