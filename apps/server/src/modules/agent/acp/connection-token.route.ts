// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  agentletConnectionCommandRequestSchema,
  agentletConnectionCredentialsRequestSchema,
} from '@huabu/shared';

import { getExternalAgentRuntimeConfig } from './runtime-config.js';
import {
  buildAgentletConnectionCommand,
  InvalidAgentletConnectionEnvFileError,
  InvalidAgentletConnectionOriginError,
} from '../../../connection-token.js';
import {
  ownDeviceCredential,
  resetAgentCredentials,
} from '../../identity/agent-credentials.js';
import { personalSettingsOwner } from '../../identity/personal-settings.js';
import { canChangeOwnSettings } from '../../security/owner.js';

import type {
  AgentletConnectionCommandRequest,
  AgentletConnectionCommandResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const connectionTokenRoutes: FastifyPluginAsync = async (app) => {
  // Revokes every connection command and agent credential the caller was
  // given, and disconnects their devices. Local mode's devices share the
  // machine connection token, which is rotated on the Server instead.
  app.post('/connection-credentials/reset', async (_request, reply) => {
    const principalId = personalSettingsOwner();
    if (!principalId)
      return reply.status(409).send({
        message: 'Device credentials are reset per user in Bubble mode only',
      });
    resetAgentCredentials(principalId);
    return reply.code(204).send();
  });

  app.post('/connection-credentials', async (request, reply) => {
    if (!canChangeOwnSettings(request)) {
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
        token: ownDeviceCredential(),
        maxAgents: getExternalAgentRuntimeConfig().maxAgents,
      });
  });

  app.post<{
    Body: AgentletConnectionCommandRequest;
    Reply: ApiResult<AgentletConnectionCommandResponse>;
  }>('/connection-command', async (request, reply) => {
    if (!canChangeOwnSettings(request)) {
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
      // A Bubble user's command carries their own device credential; locally
      // it is the machine token, reported with where it came from.
      const response = personalSettingsOwner()
        ? buildAgentletConnectionCommand(parsed.data, {
            token: ownDeviceCredential(),
            source: 'managed',
          })
        : buildAgentletConnectionCommand(parsed.data);
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
