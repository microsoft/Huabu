/**
 * `POST/GET /api/acp/pair` + `DELETE /api/acp/pair/:id` — ephemeral
 * pairing tokens for the external-agent (ACP) bridge.
 *
 * Replaces the older `GET/PUT /api/acp/config` enable-flag + persistent
 * token surface. The flow is now:
 *
 *   1. User opens Settings → External Agents and clicks "Generate code".
 *      Web client POSTs here; server mints a fresh ticket and returns
 *      it to the UI.
 *   2. User passes the code to `bin/agentlet --token <code>` in their
 *      terminal. agentlet's `bridge/hello` is validated by the token
 *      store, which atomically claims the ticket and binds it to the
 *      reporting `agentId` (see `./token-store.ts`).
 *   3. Subsequent reconnects with the same `agentId` keep working.
 *      Graceful disconnect, user revoke, or server restart all
 *      invalidate the ticket.
 *
 * Security: loopback-only on every verb. The pair endpoints reveal
 * the active codes in plaintext, and creating a code authorises a new
 * agentlet to connect — both are loopback-only the same way LLM
 * settings and workspace settings are.
 */

import { getTokenStore } from './token-store.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type {
  AcpPairingCreatedResponse,
  AcpPairingListResponse,
  ApiResult,
} from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpPairRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Reply: ApiResult<AcpPairingCreatedResponse> }>(
    '/pair',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: ACP pairing can only be created from localhost',
        });
      }
      return getTokenStore().createTicket();
    },
  );

  app.get<{ Reply: ApiResult<AcpPairingListResponse> }>(
    '/pair',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message: 'Forbidden: ACP pairing can only be read from localhost',
        });
      }
      return { tickets: getTokenStore().list() };
    },
  );

  app.delete<{
    Params: { id: string };
    Reply: ApiResult<{ revoked: boolean }>;
  }>('/pair/:id', async (request, reply) => {
    if (!isLoopbackRequest(request)) {
      return reply.status(403).send({
        message: 'Forbidden: ACP pairing can only be revoked from localhost',
      });
    }
    const revoked = getTokenStore().revoke(request.params.id);
    return { revoked };
  });
};

export default acpPairRoutes;
