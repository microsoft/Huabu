/**
 * `GET/PUT /api/acp/config` — ACP bridge configuration.
 *
 * Lets the user enable/disable the external-agent bridge and rotate the
 * shared `agentlet` token from the Settings UI, instead of editing
 * `.env` and restarting the server.
 *
 * Security: identical guard pattern to `llm.route.ts` — writes (PUT) are
 * localhost-only and gated by the global Origin-header guard. Reads (GET) are
 * also localhost-only because the response exposes the bridge token in
 * plaintext (loopback is the entire trust boundary for the current
 * single-user design).
 */

import { acpConfigUpdateSchema } from '@sediment/shared';

import { loadAcpConfig, setAcpConfig } from './config.js';

import type { AcpConfig, AcpConfigUpdate, ApiResult } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/** Match the localhost-guard helper used by `llm.route.ts`. */
function isLocalhost(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const acpConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpConfig> }>(
    '/config',
    async (request, reply) => {
      if (!isLocalhost(request.ip)) {
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
      if (!isLocalhost(request.ip)) {
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
