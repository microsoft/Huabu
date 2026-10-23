// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentletConnectionCommandRequestSchema,
  agentletConnectionCredentialsRequestSchema,
} from '@huabu/shared';

import { getExternalAgentRuntimeConfig } from './runtime-config.js';
import {
  buildAgentletConnectionCommand,
  getConnectionToken,
  InvalidAgentletConnectionEnvFileError,
  InvalidAgentletConnectionOriginError,
} from '../../../connection-token.js';
import { isOwnerRequest } from '../../security/owner.js';

import type {
  AgentletConnectionCommandRequest,
  AgentletConnectionCommandResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const connectionTokenRoutes: FastifyPluginAsync = async (app) => {
  app.post('/connection-credentials', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: device connection requires owner authorization',
      });
    }
    const parsed = agentletConnectionCredentialsRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply.status(400).send({ message: 'Invalid connection request' });
    }
    return reply
      .header('Cache-Control', 'no-store')
      .header('Pragma', 'no-cache')
      .send({
        token: getConnectionToken(),
        maxAgents: getExternalAgentRuntimeConfig().maxAgents,
      });
  });

  app.post<{
    Body: AgentletConnectionCommandRequest;
    Reply: ApiResult<AgentletConnectionCommandResponse>;
  }>('/connection-command', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: connection command requires owner authorization',
      });
    }
    const parsed = agentletConnectionCommandRequestSchema.safeParse(
      request.body,
    );
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    const requestOrigin = request.headers.origin;
    if (requestOrigin && requestOrigin !== parsed.data.origin) {
      return reply
        .status(400)
        .send({ message: 'Browser origin does not match request origin' });
    }
    try {
      const response = buildAgentletConnectionCommand(parsed.data);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send(response);
    } catch (error) {
      if (error instanceof InvalidAgentletConnectionOriginError) {
        return reply.status(400).send({ message: 'Invalid browser origin' });
      }
      if (error instanceof InvalidAgentletConnectionEnvFileError)
        return reply.status(400).send({ message: error.message });
      throw error;
    }
  });
};

export default connectionTokenRoutes;
