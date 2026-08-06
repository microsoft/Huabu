import { externalAgentRuntimeConfigSchema } from '@huabu/shared';

import {
  getExternalAgentRuntimeConfig,
  setExternalAgentRuntimeConfig,
} from './runtime-config.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type { ApiResult, ExternalAgentRuntimeConfig } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const externalAgentRuntimeConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<ExternalAgentRuntimeConfig> }>(
    '/runtime-config',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: external-agent runtime config is loopback-only',
        });
      }
      return getExternalAgentRuntimeConfig();
    },
  );

  app.put<{
    Body: ExternalAgentRuntimeConfig;
    Reply: ApiResult<ExternalAgentRuntimeConfig>;
  }>('/runtime-config', async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: external-agent runtime config is loopback-only',
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
