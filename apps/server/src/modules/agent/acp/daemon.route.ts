/**
 * `GET  /api/acp/agentlet`         — health snapshot of the embedded agentlet
 * `POST /api/acp/agentlet/restart` — force-restart the agentlet supervisor
 *
 * The agentlet is server-managed infrastructure (forked at boot by
 * {@link getDaemonSupervisor}); these endpoints exist purely so the
 * UI can render a single troubleshooting affordance when the
 * supervisor's auto-restart budget is exhausted.
 *
 * Both verbs are loopback-only — exposing a "restart worker" button
 * to a remote browser would be a trivial DoS.
 */

import { getDaemonSupervisor } from '@agenetes/agentlet-host';

import { isLoopbackRequest } from '../../security/peer.js';

import type {
  AcpAgentletRestartResponse,
  AcpAgentletStatusResponse,
  ApiResult,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpAgentletRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpAgentletStatusResponse> }>(
    '/agentlet',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: agentlet status is loopback-only',
        });
      }
      return getDaemonSupervisor().getStatus();
    },
  );

  app.post<{ Reply: ApiResult<AcpAgentletRestartResponse> }>(
    '/agentlet/restart',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: agentlet restart is loopback-only',
        });
      }
      return getDaemonSupervisor().restart();
    },
  );
};

export default acpAgentletRoutes;
