// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  capabilityConfigUpdateSchema,
  capabilityParamsSchema,
} from '@huabu/shared';

import { isOwnerRequest } from '../security/owner.js';

import { capabilityProvisionService, CapabilityServiceError } from './index.js';

import type {
  ApiResult,
  CapabilityConfig,
  CapabilityConfigUpdate,
  CapabilityListResponse,
  CapabilityParams,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function statusFor(error: CapabilityServiceError): number {
  switch (error.code) {
    case 'capability_not_found':
      return 404;
    case 'invalid_capability_config':
      return 400;
    default:
      return 409;
  }
}

const capabilityRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<CapabilityListResponse> }>('/', async () => ({
    capabilities: capabilityProvisionService.list(),
  }));

  app.get<{
    Params: CapabilityParams;
    Reply: ApiResult<CapabilityConfig>;
  }>('/:capabilityId', async (request, reply) => {
    const parsed = capabilityParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid Capability id',
      });
    }
    try {
      return reply.send(
        capabilityProvisionService.getConfig(parsed.data.capabilityId),
      );
    } catch (error) {
      if (error instanceof CapabilityServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.put<{
    Params: CapabilityParams;
    Body: CapabilityConfigUpdate;
    Reply: ApiResult<CapabilityConfig>;
  }>('/:capabilityId', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.code(403).send({
        message: 'Forbidden: Capability settings require owner authorization',
      });
    }
    const params = capabilityParamsSchema.safeParse(request.params);
    const body = capabilityConfigUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const issue = !params.success
        ? params.error.issues[0]
        : !body.success
          ? body.error.issues[0]
          : undefined;
      return reply.code(400).send({
        message: issue?.message ?? 'Invalid Capability update',
      });
    }
    try {
      return reply.send(
        await capabilityProvisionService.updateConfig(
          params.data.capabilityId,
          body.data.values,
        ),
      );
    } catch (error) {
      if (error instanceof CapabilityServiceError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });
};

export default capabilityRoutes;
