// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `GET  /api/acp/agentlet`         — health snapshot of the embedded agentlet
 * `POST /api/acp/agentlet/restart` — force-restart the agentlet supervisor
 *
 * The agentlet is server-managed infrastructure (forked at boot by
 * {@link getDaemonSupervisor}); these endpoints exist purely so the
 * UI can render a single troubleshooting affordance when the
 * supervisor's auto-restart budget is exhausted.
 *
 * Both verbs require the owner because restarting the worker disrupts
 * active agent operations.
 */

import { getDaemonSupervisor } from '@agenetes/agentlet-host';

import { isOwnerRequest } from '../../security/owner.js';

import type {
  AcpAgentletRestartResponse,
  AcpAgentletStatusResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpAgentletRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpAgentletStatusResponse> }>(
    '/agentlet',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: agentlet status requires owner authorization',
        });
      }
      return getDaemonSupervisor().getStatus();
    },
  );

  app.post<{ Reply: ApiResult<AcpAgentletRestartResponse> }>(
    '/agentlet/restart',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: agentlet restart requires owner authorization',
        });
      }
      return getDaemonSupervisor().restart();
    },
  );
};

export default acpAgentletRoutes;
