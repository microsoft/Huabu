// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentletConnectionCommandRequestSchema,
  connectionTokenUpdateSchema,
} from '@huabu/shared';

import {
  buildAgentletConnectionCommand,
  getConnectionTokenConfig,
  InvalidAgentletConnectionOriginError,
  setConnectionToken,
} from '../../../connection-token.js';
import { isOwnerRequest } from '../../security/owner.js';

import type {
  AgentletConnectionCommandRequest,
  AgentletConnectionCommandResponse,
  ApiResult,
  ConnectionTokenConfig,
  ConnectionTokenUpdate,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const connectionTokenRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<ConnectionTokenConfig> }>(
    '/connection-token',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message:
            'Forbidden: connection token settings require owner authorization',
        });
      }
      return getConnectionTokenConfig();
    },
  );

  app.put<{
    Body: ConnectionTokenUpdate;
    Reply: ApiResult<ConnectionTokenConfig>;
  }>('/connection-token', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message:
          'Forbidden: connection token settings require owner authorization',
      });
    }
    const parsed = connectionTokenUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
    }
    return reply.send(await setConnectionToken(parsed.data.token));
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
      const response = buildAgentletConnectionCommand(parsed.data.origin);
      return reply
        .header('Cache-Control', 'no-store')
        .header('Pragma', 'no-cache')
        .send(response);
    } catch (error) {
      if (error instanceof InvalidAgentletConnectionOriginError) {
        return reply.status(400).send({ message: 'Invalid browser origin' });
      }
      throw error;
    }
  });
};

export default connectionTokenRoutes;
