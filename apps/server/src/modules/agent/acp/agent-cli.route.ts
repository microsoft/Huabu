// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `GET /api/acp/agent-cli` — agentlet-local ACP harness detection.
 *
 * Powers the Agent picker in the Settings UI. The response includes the
 * complete trusted catalogue with an `installed` flag so missing agents can
 * remain visible with installation guidance. The user picks an installed
 * CLI when creating a profile; the server then
 * spawns it (via the embedded agentlet daemon) on demand. There is no
 * longer any pairing / clipboard step \u2014 the wrapper script and on-PATH
 * agentlet check were removed in the daemon-mode refactor.
 *
 * Owner-only. This adapter never probes the Huabu Server's PATH.
 */

import {
  getAgentletGateway,
  getSupervisedAgentletId,
} from '@agenetes/agentlet-host';

import { isOwnerRequest } from '../../security/owner.js';

import type {
  AcpAgentCliInfo,
  AcpAgentCliListResponse,
  ApiResult,
} from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

async function detectAgentClis(): Promise<AcpAgentCliInfo[]> {
  const gateway = getAgentletGateway();
  if (!gateway) throw new Error('Agentlet Gateway is not ready');
  const result = await gateway.discoverHarnesses(getSupervisedAgentletId(), {
    prepareWorkspaces: false,
  });
  return result.harnesses;
}

export function createAcpAgentCliRoutes(
  detect: typeof detectAgentClis = detectAgentClis,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
      '/agent-cli',
      async (request, reply) => {
        if (!isOwnerRequest(request)) {
          return reply.status(403).send({
            message:
              'Forbidden: agent CLI detection requires owner authorization',
          });
        }
        try {
          return { agents: await detect() };
        } catch (error) {
          request.log.warn(
            { err: error },
            '[acp] agentlet harness detection failed',
          );
          return reply.status(503).send({
            message: 'Agentlet harness detection is unavailable',
            code: 'harness_discovery_unavailable',
          });
        }
      },
    );
  };
}

export default createAcpAgentCliRoutes();
