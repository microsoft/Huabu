// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  canaryCheckRequestSchema,
  canaryRedeployConfigUpdateSchema,
  canaryRedeployRequestSchema,
  type ApiResult,
  type CanaryCheckRequest,
  type CanaryRedeployConfigUpdate,
  type CanaryRedeployRequest,
  type CanaryRedeployStatusResponse,
} from '@huabu/shared';

import {
  CanaryRedeployError,
  checkCanaryRemote,
  getCanaryRedeployStatus,
  requestCanaryRedeploy,
  setCanaryRedeployConfig,
} from './canary-redeploy.js';
import { isOwnerRequest } from './owner.js';

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

function sendCanaryError(
  reply: FastifyReply,
  error: unknown,
  fallback: string,
) {
  if (error instanceof CanaryRedeployError) {
    const status =
      error.code === 'operation_in_progress' || error.code === 'stale_branch'
        ? 409
        : error.code === 'branch_invalid'
          ? 400
          : error.code === 'branch_unavailable'
            ? 422
            : error.code === 'config_invalid'
              ? 500
              : 503;
    return reply.status(status).send({
      message: error.message,
      code: `canary_${error.code}`,
    });
  }
  return reply.status(500).send({
    message: fallback,
    code: 'canary_internal_error',
  });
}

const canaryRedeployRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request, reply) => {
    if (!isOwnerRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: Canary redeployment requires owner authorization',
      });
    }
  });

  app.get<{ Reply: ApiResult<CanaryRedeployStatusResponse> }>(
    '/',
    async (request, reply) => {
      try {
        return await getCanaryRedeployStatus();
      } catch (error) {
        request.log.error({ err: error }, 'Unable to read Canary status');
        return sendCanaryError(
          reply,
          error,
          'Unable to load Canary redeployment status',
        );
      }
    },
  );

  app.put<{
    Body: CanaryRedeployConfigUpdate;
    Reply: ApiResult<CanaryRedeployStatusResponse>;
  }>('/config', async (request, reply) => {
    const parsed = canaryRedeployConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ??
          'Invalid Canary branch configuration',
        code: 'validation_failed',
      });
    }
    try {
      return await setCanaryRedeployConfig(parsed.data);
    } catch (error) {
      request.log.warn({ err: error }, 'Unable to save Canary branch');
      return sendCanaryError(
        reply,
        error,
        'Unable to save Canary branch configuration',
      );
    }
  });

  app.post<{
    Body: CanaryCheckRequest;
    Reply: ApiResult<CanaryRedeployStatusResponse>;
  }>('/check', async (request, reply) => {
    const parsed = canaryCheckRequestSchema.safeParse(request.body);
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
      return sendCanaryError(reply, error, 'Unable to check Canary branch');
    }
  });

  app.post<{
    Body: CanaryRedeployRequest;
    Reply: ApiResult<CanaryRedeployStatusResponse>;
  }>('/redeploy', async (request, reply) => {
    const parsed = canaryRedeployRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        message:
          parsed.error.issues[0]?.message ?? 'Invalid Canary redeploy request',
        code: 'validation_failed',
      });
    }
    try {
      const status = await requestCanaryRedeploy(parsed.data.expectedBranch);
      return reply.status(202).send(status);
    } catch (error) {
      request.log.error({ err: error }, 'Unable to start Canary redeployment');
      return sendCanaryError(
        reply,
        error,
        'Canary redeployment is unavailable',
      );
    }
  });
};

export default canaryRedeployRoutes;
