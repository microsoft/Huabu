// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  setPersonMemberSchema,
  setPersonWorkspaceRoleSchema,
} from '@huabu/shared';

import { getRequestIdentity, requireRequestIdentity } from './request.js';
import { getWorkspaceRepository } from '../storage/index.js';

import type { IdentityService } from './service.js';
import type { FastifyPluginAsync } from 'fastify';

/**
 * People administration for a Bubble deployment: who may use Huabu, and with
 * which Workspace roles. An administrator's alone; absent in local mode, where
 * there is one person. Revocation reaches open streams at their next
 * revalidation, as every other grant change does.
 */
const peopleRoutes: FastifyPluginAsync<{ service: IdentityService }> = async (
  app,
  { service },
) => {
  const people = service.people;
  if (!people) {
    app.addHook('preHandler', async (_request, reply) =>
      reply.code(404).send({ message: 'Not found' }),
    );
    return;
  }
  app.addHook('preHandler', async (request, reply) => {
    if (!getRequestIdentity(request)?.owner)
      return reply.code(403).send({
        message: 'Administering people requires an administrator',
        code: 'ADMIN_REQUIRED',
      });
  });

  app.get('/', async () => people.list());

  app.put<{ Params: { principalId: string } }>(
    '/:principalId/member',
    async (request, reply) => {
      const body = setPersonMemberSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ message: 'Invalid request body' });
      const by = requireRequestIdentity(request).principal.principalId;
      // An administrator cannot lock themselves out from here.
      if (!body.data.member && request.params.principalId === by)
        return reply
          .code(409)
          .send({ message: 'You cannot revoke your own access' });
      if (
        !(await people.setMember(
          request.params.principalId,
          body.data.member,
          by,
        ))
      )
        return reply.code(404).send({ message: 'No such person' });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { principalId: string; workspaceId: string } }>(
    '/:principalId/workspaces/:workspaceId',
    async (request, reply) => {
      const body = setPersonWorkspaceRoleSchema.safeParse(request.body);
      if (!body.success)
        return reply.code(400).send({ message: 'Invalid request body' });
      const { principalId, workspaceId } = request.params;
      if (body.data.role && !(await getWorkspaceRepository().get(workspaceId)))
        return reply.code(404).send({ message: 'Workspace not found' });
      const by = requireRequestIdentity(request).principal.principalId;
      if (
        !(await people.setWorkspaceRole(
          principalId,
          workspaceId,
          body.data.role,
          by,
        ))
      )
        return reply.code(404).send({ message: 'No such person' });
      return reply.code(204).send();
    },
  );
};

export default peopleRoutes;
