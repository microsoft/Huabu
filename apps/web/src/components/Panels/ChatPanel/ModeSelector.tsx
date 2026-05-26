/**
 * `ModeSelector` — the pill-shaped dropdown in the ChatPanel input bar
 * that owns *both* the built-in agent mode (Ask / Agent) **and** the
 * thread → external-agent binding picker.
 *
 * Rule: 1 thread = 1 agent binding. The user picks once at the top of
 * a thread and the choice is immutable until they start a new thread.
 *
 * Option-list shape:
 *   ┌────────────────────────┐
 *   │ 💬  Ask                 │   ← internal binding, mode='ask'
 *   │ 🌱  Agent               │   ← internal binding, mode='operate'
 *   │ ─── External ───        │   (section divider, only when agents connected)
 *   │ 🔌  claude              │   ← external binding, agentId='claude:…'
 *   │ 🔌  cursor              │
 *   └────────────────────────┘
 *
 * The Select component only knows about flat string `value`s, so we
 * encode the (mode, binding) pair into synthetic keys (`mode:ask`,
 * `mode:operate`, `agent:<agentletAgentId>`) and decode in `onChange`.
 */
import { MessageSquare, Plug, RefreshCw, Sprout } from 'lucide-react';

import { Button } from '../../Common/Button';
import { Select, type SelectOption } from '../../Common/Select';

import type {
  AcpAgentSummary,
  AgentBinding,
  AgentMode,
} from '@sediment/shared';

interface ModeSelectorProps {
  /** Current built-in mode. Persisted even when an external binding is active. */
  mode: AgentMode;
  /** Current thread binding. `{kind:'internal'}` means the built-in agent is active. */
  binding: AgentBinding;
  /** External agents currently connected through the ACP bridge. */
  connectedAgents: AcpAgentSummary[];
  onModeChange: (mode: AgentMode) => void;
  onBindingChange: (binding: AgentBinding) => void;
  /**
   * Re-fetch the connected-agents list. Wired to the "Refresh agents"
   * button in the dropdown footer; the picker never auto-refreshes
   * (mount-time fetch + explicit user action only) to keep the request
   * volume to the bridge minimal.
   */
  onRefreshAgents?: () => void | Promise<void>;
  /** True while an agent-list fetch is in flight — spins the refresh icon. */
  refreshing?: boolean;
  /**
   * When true, individual options are greyed out and cannot be picked.
   * The dropdown itself can still be *opened* so the user can see the
   * current binding and the available agents — only the act of changing
   * the binding is blocked. ChatPanel sets this once the thread has any
   * messages or a stream is in flight (1 thread = 1 binding).
   */
  locked?: boolean;
  /** Backward-compat: forwarded to the underlying Select. */
  disabled?: boolean;
}

/** Internal value encoding — keep all keys distinct from any future agentId prefix. */
type SelectorValue = `mode:${AgentMode}` | `agent:${string}`;

function encodeValue(mode: AgentMode, binding: AgentBinding): SelectorValue {
  if (binding.kind === 'external') {
    return `agent:${binding.agentletAgentId}`;
  }
  return `mode:${mode}`;
}

export const ModeSelector = ({
  mode,
  binding,
  connectedAgents,
  onModeChange,
  onBindingChange,
  onRefreshAgents,
  refreshing = false,
  locked = false,
  disabled = false,
}: ModeSelectorProps) => {
  const value = encodeValue(mode, binding);

  // Built-in modes always lead the list.
  const modeOptions: SelectOption<SelectorValue>[] = [
    {
      value: 'mode:ask',
      label: 'Ask',
      icon: <MessageSquare size={14} />,
      disabled: locked,
    },
    {
      value: 'mode:operate',
      label: 'Agent',
      icon: <Sprout size={14} />,
      disabled: locked,
    },
  ];

  // External agents follow, with a section divider on the first entry.
  // We *don't* render a "no agents connected" placeholder — the absence
  // is information enough, and the built-in modes still work.
  const agentOptions: SelectOption<SelectorValue>[] = connectedAgents.map(
    (agent, index) => ({
      value: `agent:${agent.agentId}` as SelectorValue,
      label: agent.alias,
      icon: <Plug size={14} />,
      description: `pid ${agent.pid}`,
      sectionLabel: index === 0 ? 'External' : undefined,
      disabled: locked,
    }),
  );

  const options = [...modeOptions, ...agentOptions];

  const handleChange = (next: SelectorValue) => {
    if (next.startsWith('mode:')) {
      const nextMode = next.slice('mode:'.length) as AgentMode;
      // Switching back to a built-in mode also clears any external binding.
      if (binding.kind !== 'internal') {
        onBindingChange({ kind: 'internal' });
      }
      onModeChange(nextMode);
      return;
    }
    if (next.startsWith('agent:')) {
      const agentId = next.slice('agent:'.length);
      const agent = connectedAgents.find((a) => a.agentId === agentId);
      if (!agent) {
        // Picked agent vanished between render and click — bail silently
        // and let the next poll refresh the list.
        return;
      }
      onBindingChange({
        kind: 'external',
        alias: agent.alias,
        agentletAgentId: agent.agentId,
      });
      return;
    }
  };

  return (
    <Select<SelectorValue>
      options={options}
      value={value}
      onChange={handleChange}
      disabled={disabled}
      variant="outline"
      shape="pill"
      tone="neutral"
      size="sm"
      align="top-left"
      footerSlot={
        <Button
          variant="ghost"
          tone="neutral"
          size="sm"
          onClick={() => {
            void onRefreshAgents?.();
          }}
          disabled={refreshing || !onRefreshAgents}
          className="w-full justify-start gap-2 rounded px-3 py-1.5 text-left"
        >
          <RefreshCw
            size={14}
            className={refreshing ? 'animate-spin' : undefined}
          />
          <span className="text-xs">
            {refreshing ? 'Refreshing…' : 'Refresh agents'}
          </span>
        </Button>
      }
    />
  );
};
