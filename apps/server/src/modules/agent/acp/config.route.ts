/**
 * `GET/PUT /api/acp/config` — ACP bridge configuration.
 *
 * Lets the user enable/disable the external-agent bridge and rotate the
 * shared `agentlet` token from the Settings UI, instead of editing
 * `.env` and restarting the server.
 *
 * Security: loopback-only on both verbs (reads expose the token in
 * plaintext; loopback is the entire trust boundary for the current
 * single-user design).
 */

import { acpConfigUpdateSchema } from '@sediment/shared';

import { loadAcpConfig, setAcpConfig } from './config.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type { AcpConfig, AcpConfigUpdate, ApiResult } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: ACP config can only be read from localhost',
        });
      }
      return loadAcpConfig();
    },
  );

  app.put<{ Body: AcpConfigUpdate; Reply: ApiResult<AcpConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: ACP config can only be changed from localhost',
        });
      }
      const parsed = acpConfigUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ message: parsed.error.issues[0]?.message ?? 'Invalid body' });
      }
      return setAcpConfig(parsed.data);
    },
  );
};

export default acpConfigRoutes;
