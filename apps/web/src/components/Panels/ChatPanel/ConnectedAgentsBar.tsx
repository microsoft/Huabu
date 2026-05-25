/**
 * `ConnectedAgentsBar` — slim status line shown above the chat input
 * listing currently-connected external ACP agents.
 *
 * Phase 2 PR A surface: pure visibility, no interactivity. PR B will
 * make these aliases clickable (or feed an `@`-autocomplete dropdown)
 * so users can route a message to a specific agent.
 *
 * Rendering rules:
 *  - Bridge disabled (`enabled === false`)  → render nothing.
 *  - First load (`enabled === null`)        → render nothing (avoids
 *    a flash of "no agents" before the first response).
 *  - Bridge enabled, no agents              → render nothing for now
 *    (avoid noisy empty state; revisit in Phase 4 when onboarding
 *    needs to advertise the bridge).
 *  - Bridge enabled, ≥ 1 agent              → green dot + comma-separated
 *    aliases, with a tooltip listing full agentId / command / host.
 */

import { Tooltip } from '@/components/Common/Tooltip';
import { useAcpAgents } from '@/hooks/useAcpAgents';

import type { AcpAgentSummary } from '@/api/acp';

function agentTooltip(agents: AcpAgentSummary[]): JSX.Element {
  return (
    <div className="flex max-w-xs flex-col gap-2 text-left">
      {agents.map((a) => (
        <div key={a.agentId} className="flex flex-col">
          <span className="font-medium">{a.alias}</span>
          <span className="text-fg-subtle text-xs break-all">{a.command}</span>
          {(a.hostname || a.platform) && (
            <span className="text-fg-subtle text-xs">
              {[a.hostname, a.platform].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export const ConnectedAgentsBar = (): JSX.Element | null => {
  const { agents, enabled } = useAcpAgents();

  if (enabled !== true) return null;
  if (agents.length === 0) return null;

  return (
    <Tooltip content={agentTooltip(agents)} placement="top">
      <div className="text-fg-muted flex cursor-default items-center gap-1.5 px-1 text-xs leading-none select-none">
        <span
          className="bg-success inline-block h-1.5 w-1.5 rounded-full"
          aria-hidden
        />
        <span className="truncate">
          {agents.map((a) => a.alias).join(' · ')}
        </span>
      </div>
    </Tooltip>
  );
};
