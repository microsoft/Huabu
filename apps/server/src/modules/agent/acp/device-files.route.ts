// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { deviceFilesBodySchema } from '@huabu/shared';

import { DeviceFilesError, DeviceFilesService } from './device-files.js';
import { isOwnerRequest } from '../../security/owner.js';

import type { FastifyPluginAsync } from 'fastify';

const deviceFilesRoutes: FastifyPluginAsync = async (app) => {
  let service: DeviceFilesService | undefined;
  app.addHook('preClose', async () => service?.dispose());
  app.post('/files', async (request, reply) => {
    if (!isOwnerRequest(request))
      return reply
        .status(403)
        .send({ message: 'Owner authorization required' });
    const parsed = deviceFilesBodySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({
        code: 'invalid_request',
        message: 'Invalid filesystem request',
      });
    reply.header('Cache-Control', 'no-store');
    try {
      service ??= new DeviceFilesService(app.log);
      return await service.execute(parsed.data);
    } catch (error) {
      request.log.warn(
        {
          code:
            error instanceof DeviceFilesError
              ? error.code
              : 'files_unavailable',
        },
        'Device file request failed',
      );
      return reply
        .status(error instanceof DeviceFilesError ? error.status : 503)
        .send({
          code:
            error instanceof DeviceFilesError
              ? error.code
              : 'files_unavailable',
          message:
            error instanceof DeviceFilesError
              ? error.message
              : 'Filesystem service unavailable',
        });
    }
  });
};
export default deviceFilesRoutes;
