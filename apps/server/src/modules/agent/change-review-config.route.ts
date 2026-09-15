// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { agentChangeReviewConfigSchema } from '@huabu/shared';

import {
  getAgentChangeReviewConfig,
  setAgentChangeReviewConfig,
} from './change-review-config.js';
import { isOwnerRequest } from '../security/owner.js';

import type { AgentChangeReviewConfig, ApiResult } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const agentChangeReviewConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AgentChangeReviewConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message:
            'Forbidden: Agent change-review config requires owner authorization',
        });
      }
      return getAgentChangeReviewConfig();
    },
  );

  app.put<{
    Body: AgentChangeReviewConfig;
    Reply: ApiResult<AgentChangeReviewConfig>;
  }>('/config', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message:
          'Forbidden: Agent change-review config requires owner authorization',
      });
    }
    const parsed = agentChangeReviewConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ??
          'Invalid Agent change-review config',
        code: 'validation_failed',
      });
    }
    return setAgentChangeReviewConfig(parsed.data);
  });
};

export default agentChangeReviewConfigRoutes;
