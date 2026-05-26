/**
 * `GET /api/acp/agents` — list currently-connected external ACP agents.
 *
 * Read-only visibility surface for the agentlet bridge. The chat panel
 * uses this endpoint to render the agent picker in the ChatPanel.
 *
 * Behaviour summary:
 *  - Always registered (so the front-end has one URL to call regardless of
 *    feature-flag state). When `SEDIMENT_ENABLE_ACP` is not set, the
 *    agentlet server was never mounted, so `getAgentletServer()` returns
 *    `null` and we reply `{ enabled: false, agents: [] }`.
 *  - When enabled, we filter `getConnections({ status: 'connected' })` and
 *    derive a short alias from `agentInfo.command` (see `deriveAlias`).
 *  - No authentication beyond the global Basic-Auth gate — the bridge
 *    itself is gated by `token-store.ts`; this route only enumerates what
 *    the in-process registry already knows about.
 */

import { getAgentletServer } from './server-mount.js';

import type { AcpAgentSummary, AcpAgentsResponse } from '@sediment/shared';
import type { FastifyPluginAsync } from 'fastify';

/**
 * Derive the short alias used as the user-facing display name and as
 * the `@mention` key.
 *
 *   `'claude --acp'`                    → `'claude'`
 *   `'/usr/local/bin/claude --acp'`     → `'claude'`
 *   `'/usr/bin/env claude --acp'`       → `'env'`   (limitation, fine for v1)
 *   `''` / whitespace                   → `'agent'` (defensive fallback)
 *
 * Limitation: two `claude --acp` instances collide on `'claude'`. Accepted
 * for now; a stable-alias `external-agents.json` registry will fix this
 * when canvas ↔ repo binding lands.
 */
export function deriveAlias(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (!first) return 'agent';
  // Strip directory components so `/usr/local/bin/claude` becomes `claude`.
  const basename = first.split('/').pop() ?? first;
  return basename || 'agent';
}

const acpAgentsRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Reply: AcpAgentsResponse }>('/agents', async () => {
    const server = getAgentletServer();
    if (!server) {
      return { enabled: false, agents: [] };
    }

    const agents: AcpAgentSummary[] = server
      .getConnections({ status: 'connected' })
      .map((conn) => {
        // Defensive: the protocol declares `agentInfo` as required, but
        // misbehaved bridges (or future schema drift) can leave it
        // undefined at runtime. Fall back to empty strings so the route
        // never 500s — the alias derivation already handles empty input.
        const command = conn.agentInfo?.command ?? '';
        const pid = conn.agentInfo?.pid ?? 0;
        return {
          agentId: conn.agentId,
          alias: deriveAlias(command),
          command,
          pid,
          hostname: conn.machine?.hostname,
          platform: conn.machine?.platform,
          connectedAt: conn.connectedAt.toISOString(),
        };
      });

    return { enabled: true, agents };
  });
};

export default acpAgentsRoutes;
