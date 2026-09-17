// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import {
  materializeDiscoveredAgentRequestSchema,
  refreshAcpAgentCliRequestSchema,
  validateAcpWorkingDirectoryRequestSchema,
} from '@huabu/shared';

import {
  AcpMachineDiscoveryError,
  acpMachineDiscovery,
  type AcpMachineDiscoveryService,
} from './machine-discovery.js';
import { isOwnerRequest } from '../../security/owner.js';

import type {
  AcpAgentCliListResponse,
  AcpProfileMutationResponse,
  ApiResult,
  ValidateAcpWorkingDirectoryResponse,
} from '@huabu/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

function authorize(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isOwnerRequest(request)) return true;
  reply.status(403).send({
    message: 'Forbidden: Agent discovery requires owner authorization',
    code: 'forbidden',
  });
  return false;
}

function sendServiceError(reply: FastifyReply, error: unknown) {
  if (error instanceof AcpMachineDiscoveryError) {
    return reply.status(error.status).send({
      message: error.message,
      code: error.code,
    });
  }
  throw error;
}

export function createAcpAgentCliRoutes(
  service: AcpMachineDiscoveryService = acpMachineDiscovery,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
      '/agent-cli',
      async (request, reply) => {
        if (!authorize(request, reply)) return;
        return service.list();
      },
    );

    app.post<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
      '/agent-cli/refresh',
      async (request, reply) => {
        if (!authorize(request, reply)) return;
        const parsed = refreshAcpAgentCliRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            message: 'Invalid Agent discovery refresh body',
            code: 'validation_failed',
          });
        }
        try {
          return await service.refresh(parsed.data.agentletId);
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.post<{ Reply: ApiResult<AcpProfileMutationResponse> }>(
      '/agent-cli/materialize',
      async (request, reply) => {
        if (!authorize(request, reply)) return;
        const parsed = materializeDiscoveredAgentRequestSchema.safeParse(
          request.body,
        );
        if (!parsed.success) {
          return reply.status(400).send({
            message: 'Invalid discovered Agent materialization body',
            code: 'validation_failed',
          });
        }
        try {
          return await service.materialize(
            parsed.data.agentletId,
            parsed.data.harnessId,
            parsed.data.workingDirPath,
          );
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );

    app.post<{ Reply: ApiResult<ValidateAcpWorkingDirectoryResponse> }>(
      '/working-directory/validate',
      async (request, reply) => {
        if (!authorize(request, reply)) return;
        const parsed = validateAcpWorkingDirectoryRequestSchema.safeParse(
          request.body,
        );
        if (!parsed.success) {
          return reply.status(400).send({
            message: 'Invalid working-directory validation body',
            code: 'validation_failed',
          });
        }
        try {
          return await service.validateWorkingDirectory(
            parsed.data.agentletId,
            parsed.data.workingDirPath,
          );
        } catch (error) {
          return sendServiceError(reply, error);
        }
      },
    );
  };
}

export default createAcpAgentCliRoutes();
