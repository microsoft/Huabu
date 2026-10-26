// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  acpAgentletDiscoveryBodySchema,
  acpAgentletDiscoveryParamsSchema,
} from '@huabu/shared';

import { HarnessProfileDiscoveryError } from './harness-profile-discovery.js';
import { isOwnerRequest } from '../../security/owner.js';

import type { registerHarnessProfileDiscovery } from './harness-profile-discovery.js';
import type { AcpAgentletDiscoveryResponse, ApiResult } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

export function createHarnessDiscoveryRoutes(
  getDiscovery: () =>
    | Pick<ReturnType<typeof registerHarnessProfileDiscovery>, 'discover'>
    | undefined,
): FastifyPluginAsync {
  return async (app) => {
    app.post<{ Reply: ApiResult<AcpAgentletDiscoveryResponse> }>(
      '/agentlets/:agentletId/discover',
      async (request, reply) => {
        if (!isOwnerRequest(request)) {
          return reply.status(403).send({
            message: 'Agent detection requires owner authorization.',
          });
        }
        const params = acpAgentletDiscoveryParamsSchema.safeParse(
          request.params,
        );
        const body = acpAgentletDiscoveryBodySchema.safeParse(request.body);
        if (!params.success || !body.success) {
          return reply.status(400).send({
            code: 'validation_failed',
            message: 'Invalid device detection request.',
          });
        }
        const discovery = getDiscovery();
        if (!discovery) {
          return reply.status(503).send({
            code: 'harness_discovery_unavailable',
            message: 'Agent detection is not ready.',
          });
        }
        try {
          return await discovery.discover(params.data.agentletId);
        } catch (error) {
          request.log.warn(
            { err: error, agentletId: params.data.agentletId },
            '[acp] device harness discovery failed',
          );
          if (error instanceof HarnessProfileDiscoveryError) {
            return reply.status(error.status).send({
              code: error.code,
              message: error.message,
              ...(error.details ? { details: error.details } : {}),
            });
          }
          return reply.status(500).send({
            code: 'harness_reconciliation_failed',
            message: 'Could not finish detecting installed Agents.',
          });
        }
      },
    );
  };
}
