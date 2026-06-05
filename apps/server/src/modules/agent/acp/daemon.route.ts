/**
 * `GET  /api/acp/daemon`         — health snapshot of the embedded daemon
 * `POST /api/acp/daemon/restart` — force-restart the daemon supervisor
 *
 * The daemon is server-managed infrastructure (forked at boot by
 * {@link getDaemonSupervisor}); these endpoints exist purely so the
 * UI can render a single troubleshooting affordance when the
 * supervisor's auto-restart budget is exhausted.
 *
 * Both verbs are loopback-only — exposing a "restart worker" button
 * to a remote browser would be a trivial DoS.
 */

import { getDaemonSupervisor } from './daemon-supervisor.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type {
  AcpDaemonRestartResponse,
  AcpDaemonStatusResponse,
  ApiResult,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpDaemonRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpDaemonStatusResponse> }>(
    '/daemon',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: daemon status is loopback-only',
        });
      }
      return getDaemonSupervisor().getStatus();
    },
  );

  app.post<{ Reply: ApiResult<AcpDaemonRestartResponse> }>(
    '/daemon/restart',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: daemon restart is loopback-only',
        });
      }
      // The restart is asynchronous (we kill the child and let the
      // exit handler re-fork on a 1s backoff). The response captures
      // the immediate post-kick state, which is almost certainly
      // `online: false`; the UI is expected to re-poll
      // `GET /api/acp/daemon` after a short delay.
      return getDaemonSupervisor().restart();
    },
  );
};

export default acpDaemonRoutes;
