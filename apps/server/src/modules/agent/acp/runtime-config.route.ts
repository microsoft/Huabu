// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { externalAgentRuntimeConfigSchema } from '@huabu/shared';

import {
  getExternalAgentRuntimeConfig,
  setExternalAgentRuntimeConfig,
} from './runtime-config.js';
import { isOwnerRequest } from '../../security/owner.js';

import type { ApiResult, ExternalAgentRuntimeConfig } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const externalAgentRuntimeConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<ExternalAgentRuntimeConfig> }>(
    '/runtime-config',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message:
            'Forbidden: external-agent runtime config requires owner authorization',
        });
      }
      return getExternalAgentRuntimeConfig();
    },
  );

  app.put<{
    Body: ExternalAgentRuntimeConfig;
    Reply: ApiResult<ExternalAgentRuntimeConfig>;
  }>('/runtime-config', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message:
          'Forbidden: external-agent runtime config requires owner authorization',
      });
    }
    const parsed = externalAgentRuntimeConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ??
          'Invalid external-agent runtime config',
        code: 'validation_failed',
      });
    }
    return setExternalAgentRuntimeConfig(parsed.data);
  });
};

export default externalAgentRuntimeConfigRoutes;
