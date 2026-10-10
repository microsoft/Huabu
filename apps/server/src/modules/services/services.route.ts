// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { serviceConfigUpdateSchema, serviceParamsSchema } from '@huabu/shared';

import { isOwnerRequest } from '../security/owner.js';

import { serviceProvisioner, ServiceProvisionError } from './index.js';

import type {
  ApiResult,
  ServiceConfig,
  ServiceConfigUpdate,
  ServiceListResponse,
  ServiceParams,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

function statusFor(error: ServiceProvisionError): number {
  switch (error.code) {
    case 'service_not_found':
      return 404;
    case 'invalid_service_config':
      return 400;
    default:
      return 409;
  }
}

const serviceRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<ServiceListResponse> }>('/', async () => ({
    services: serviceProvisioner.list(),
  }));

  app.get<{
    Params: ServiceParams;
    Reply: ApiResult<ServiceConfig>;
  }>('/:serviceId', async (request, reply) => {
    const parsed = serviceParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({
        message: parsed.error.issues[0]?.message ?? 'Invalid Service id',
      });
    }
    try {
      return reply.send(serviceProvisioner.getConfig(parsed.data.serviceId));
    } catch (error) {
      if (error instanceof ServiceProvisionError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.put<{
    Params: ServiceParams;
    Body: ServiceConfigUpdate;
    Reply: ApiResult<ServiceConfig>;
  }>('/:serviceId', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.code(403).send({
        message: 'Forbidden: Service settings require owner authorization',
      });
    }
    const params = serviceParamsSchema.safeParse(request.params);
    const body = serviceConfigUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      const issue = !params.success
        ? params.error.issues[0]
        : !body.success
          ? body.error.issues[0]
          : undefined;
      return reply.code(400).send({
        message: issue?.message ?? 'Invalid Service update',
      });
    }
    try {
      return reply.send(
        await serviceProvisioner.updateConfig(
          params.data.serviceId,
          body.data.values,
        ),
      );
    } catch (error) {
      if (error instanceof ServiceProvisionError) {
        return reply
          .code(statusFor(error))
          .send({ message: error.message, code: error.code });
      }
      throw error;
    }
  });
};

export default serviceRoutes;
