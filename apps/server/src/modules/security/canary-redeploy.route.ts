// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canaryRedeployRequestSchema,
  type ApiResult,
  type CanaryRedeployRequest,
  type CanaryRedeployStatusResponse,
} from '@huabu/shared';

import {
  checkCanaryRemote,
  getCanaryRedeployStatus,
  requestCanaryRedeploy,
} from './canary-redeploy.js';
import { isOwnerRequest } from './owner.js';

import type { FastifyPluginAsync } from 'fastify';

const canaryRedeployRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<CanaryRedeployStatusResponse> }>(
    '/',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message:
            'Forbidden: Canary redeployment requires owner authorization',
        });
      }
      return getCanaryRedeployStatus();
    },
  );

  app.post<{
    Body: CanaryRedeployRequest;
    Reply: ApiResult<CanaryRedeployStatusResponse>;
  }>('/check', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: Canary redeployment requires owner authorization',
      });
    }
    const parsed = canaryRedeployRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ?? 'Invalid Canary check request',
        code: 'validation_failed',
      });
    }
    try {
      return await checkCanaryRemote();
    } catch (error) {
      request.log.warn({ err: error }, 'Canary update check failed');
      return reply.status(502).send({
        message: 'Unable to resolve origin/alpha',
        code: 'canary_check_failed',
      });
    }
  });

  app.post<{
    Body: CanaryRedeployRequest;
    Reply: ApiResult<CanaryRedeployStatusResponse>;
  }>('/redeploy', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: Canary redeployment requires owner authorization',
      });
    }
    const parsed = canaryRedeployRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ?? 'Invalid Canary redeploy request',
        code: 'validation_failed',
      });
    }
    try {
      const status = await requestCanaryRedeploy();
      return reply.status(202).send(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'Canary redeployment is already in progress') {
        return reply.status(409).send({
          message,
          code: 'canary_redeploy_in_progress',
        });
      }
      request.log.error({ err: error }, 'Unable to start Canary redeployment');
      return reply.status(503).send({
        message: 'Canary redeployment is unavailable',
        code: 'canary_redeploy_unavailable',
      });
    }
  });
};

export default canaryRedeployRoutes;
