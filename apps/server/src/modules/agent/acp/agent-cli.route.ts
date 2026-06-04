/**
 * `GET /api/acp/agent-cli` — host-side detection of installed ACP-capable
 * agent CLIs (Copilot / Claude / Gemini).
 *
 * Powers the "Detected agents" cards in the Settings UI. The user picks
 * one of the detected CLIs when creating a profile; the server then
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

import type { AcpAgentCliListResponse, ApiResult } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

const acpAgentCliRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: ApiResult<AcpAgentCliListResponse> }>(
    '/agent-cli',
    async (request, reply) => {
      if (!isLoopbackRequest(request)) {
        return reply.status(403).send({
          message:
            'Forbidden: agent CLI detection is loopback-only (host-side probe)',
        });
      }
      const allAgents = await detectAgentClis();
      // Phase A-Agentlet.1 design: only surface installed agents.
      // Users who want to install a missing one follow `installHint`
      // from the README / docs, not an inline UI placeholder.
      const installed = allAgents.filter((a) => a.installed);
      return {
        agents: installed,
      };
    },
  );
};

export default acpAgentCliRoutes;
