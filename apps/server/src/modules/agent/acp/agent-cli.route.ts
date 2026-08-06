// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * `GET /api/acp/agent-cli` — host-side detection of installed ACP-capable
 * agent CLIs from the trusted built-in catalogue.
 *
 * Powers the Agent picker in the Settings UI. The response includes the
 * complete trusted catalogue with an `installed` flag so missing agents can
 * remain visible with installation guidance. The user picks an installed
 * CLI when creating a profile; the server then
 * spawns it (via the embedded agentlet daemon) on demand. There is no
 * longer any pairing / clipboard step \u2014 the wrapper script and on-PATH
 * agentlet check were removed in the daemon-mode refactor.
 *
 * Security: loopback-only. Detection shells out to `which` / `where` and
 * `<binary> --version`; both are local-only operations and must never
 * be triggerable from a remote browser.
 */

import { detectAgentClis } from './agent-cli-detect.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type { AcpAgentCliListResponse, ApiResult } from '@huabu/shared';
import type { FastifyPluginAsync } from 'fastify';

export function createAcpAgentCliRoutes(
  detect: typeof detectAgentClis = detectAgentClis,
): FastifyPluginAsync {
  return async (app) => {
    app.get<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
      '/agent-cli',
      async (request, reply) => {
        if (!isLoopbackRequest(request)) {
          return reply.status(403).send({
            message:
              'Forbidden: agent CLI detection is loopback-only (host-side probe)',
          });
        }
        return {
          agents: await detect(),
        };
      },
    );
  };
}

export default createAcpAgentCliRoutes();
