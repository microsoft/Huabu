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
 * active agent operations. Bubble supervises no worker, so both answer 404
 * there instead of reporting or starting one.
 */

import { getDaemonSupervisor } from '@agenetes/agentlet-host';

import { personalSettingsOwner } from '../../identity/personal-settings.js';
import { isOwnerRequest } from '../../security/owner.js';

import type {
  AcpAgentletRestartResponse,
  AcpAgentletStatusResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

const NO_WORKER = {
  message: 'This Server runs no shared agent worker',
  code: 'AGENTLET_UNAVAILABLE',
} as const;

const acpAgentletRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpAgentletStatusResponse> }>(
    '/agentlet',
    async (request, reply) => {
      if (!isOwnerRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: agentlet status requires owner authorization',
        });
      }
      if (personalSettingsOwner()) return reply.status(404).send(NO_WORKER);
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
      if (personalSettingsOwner()) return reply.status(404).send(NO_WORKER);
      return getDaemonSupervisor().restart();
    },
  );
};

export default acpAgentletRoutes;
