/**
 * `GET /api/acp/agent-cli` — host-side detection of installed ACP-capable
 * agent CLIs (Copilot / Claude / Gemini), plus a `agentlet` PATH check.
 *
 * Powers the "Detected agents" cards in the Settings UI. For each
 * detected CLI the UI renders one "Connect" button that:
 *   1. Mints a fresh pairing ticket (`POST /api/acp/pair`).
 *   2. Builds the full `bin/agentlet --token … --agent "…"` command.
 *   3. Copies it to the clipboard for the user to paste in a terminal.
 *
 * Security: loopback-only. Detection shells out to `which` / `where` and
 * `<binary> --version`; both are local-only operations and must never
 * be triggerable from a remote browser.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectAgentClis, detectAgentletOnPath } from './agent-cli-detect.js';
import { isLoopbackRequest } from '../../security/peer.js';

import type { AcpAgentCliListResponse, ApiResult } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Resolve the absolute path to the `agentlet` wrapper script, or
 * `null` when the wrapper isn't available on this host.
 *
 * Resolution order (first hit wins):
 *   1. `HUABU_AGENTLET_PATH` env var — set by the dev-mode Electron
 *      main process to point at `bin/agentlet` inside the monorepo.
 *      Packaged builds intentionally do NOT set this (the wrapper is
 *      not shipped — see `apps/desktop/electron-builder.yml`).
 *   2. Relative path from this module's location — works in dev and
 *      standalone-server deployments where the source tree is intact.
 *
 * The result is the **existence-checked** path: if neither candidate
 * points at a real file we return `null`, and the Settings UI shows
 * the section without an in-repo wrapper hint.
 */
function resolveAgentletWrapperPath(): string | null {
  const envPath = process.env.HUABU_AGENTLET_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const relPath = path.resolve(here, '../../../../../..', 'bin', 'agentlet');
  return existsSync(relPath) ? relPath : null;
}

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
      const [allAgents, agentletOnPath] = await Promise.all([
        detectAgentClis(),
        detectAgentletOnPath(),
      ]);
      // Phase A-Agentlet.1 design: only surface installed agents.
      // Users who want to install a missing one follow `installHint`
      // from the README / docs, not an inline UI placeholder.
      const installed = allAgents.filter((a) => a.installed);
      return {
        agents: installed,
        agentletOnPath,
        agentletWrapperPath: resolveAgentletWrapperPath(),
      };
    },
  );
};

export default acpAgentCliRoutes;
