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
 *   │ 💬  Chat         Huabu  │   ← internal binding, mode='ask'
 *   │ 🌱  Agent        Huabu  │   ← internal binding, mode='operate'
 *   │ 🔌  claude              │   ← external binding, agentId='claude:…'
 *   │ 🔌  cursor              │
 *   └────────────────────────┘
 *
 * The Select component only knows about flat string `value`s, so we
 * encode the (mode, binding) pair into synthetic keys (`mode:ask`,
 * `mode:operate`, `agent:<agentletAgentId>`) and decode in `onChange`.
 */
import { MessageSquare, Plus, RefreshCw, Route, Sprout } from 'lucide-react';
import { useEffect } from 'react';

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
   * Start a fresh chat thread. Wired to the "New chat session" button in
   * the dropdown footer. Since 1 thread = 1 binding, this is the only way
   * to re-open the binding picker once a thread is locked.
   */
  onNewThread?: () => void;
  /**
   * When true, individual options are greyed out and cannot be picked.
   * The dropdown itself can still be *opened* so the user can see the
   * current binding and the available agents — only the act of changing
   * the binding is blocked. ChatPanel sets this once the thread has any
   * messages or a stream is in flight (1 thread = 1 binding).
   */
  locked?: boolean;
  /**
   * True once the bridge has responded with a definitive agent list
   * (success or empty). Gates the auto-reset that drops a stale
   * external binding on a fresh thread — we wait for a real answer so a
   * still-loading list doesn't trigger a premature reset.
   */
  agentsListReady?: boolean;
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
  onNewThread,
  refreshing = false,
  locked = false,
  agentsListReady = false,
  disabled = false,
}: ModeSelectorProps) => {
  const value = encodeValue(mode, binding);

  // Detect a stale external binding: the thread was last bound to an
  // ACP agent that is no longer connected (bridge restart, agent
  // exited, etc.). Drives both the disabled placeholder option below
  // and the auto-reset effect for unlocked threads.
  const boundExternalMissing =
    binding.kind === 'external' &&
    !connectedAgents.some((a) => a.agentId === binding.agentletAgentId);

  // Fresh thread + stale binding → silently fall back to the built-in
  // internal agent so the trigger doesn't read "Select…". For locked
  // threads we keep the binding so the synthesized placeholder option
  // (see below) can still surface the disconnected agent name.
  useEffect(() => {
    if (locked) return;
    if (!agentsListReady) return;
    if (!boundExternalMissing) return;
    onBindingChange({ kind: 'internal' });
  }, [locked, agentsListReady, boundExternalMissing, onBindingChange]);

  // Built-in modes always lead the list.
  const modeOptions: SelectOption<SelectorValue>[] = [
    {
      value: 'mode:ask',
      label: 'Chat',
      description: 'Huabu',
      icon: <MessageSquare size={14} />,
      disabled: locked,
    },
    {
      value: 'mode:operate',
      label: 'Agent',
      description: 'Huabu',
      icon: <Sprout size={14} />,
      disabled: locked,
    },
  ];

  // External agents follow, with a section divider on the first entry.
  // We *don't* render a "no agents connected" placeholder — the absence
  // is information enough, and the built-in modes still work.
  const agentOptions: SelectOption<SelectorValue>[] = connectedAgents.map(
    (agent) => ({
      value: `agent:${agent.agentId}` as SelectorValue,
      label: agent.alias,
      icon: <Route size={14} />,
      description: `pid ${agent.pid}`,
      disabled: locked,
    }),
  );

  // Locked thread bound to a now-disconnected agent: synthesize a
  // disabled option so the trigger still reads the alias (instead of
  // the bare "Select…" placeholder) and the user has a visible cue to
  // hit Refresh. The unlocked case is handled by the effect above.
  const disconnectedOption: SelectOption<SelectorValue>[] =
    locked && boundExternalMissing && binding.kind === 'external'
      ? [
          {
            value: `agent:${binding.agentletAgentId}` as SelectorValue,
            label: binding.alias,
            icon: <Route size={14} />,
            description: 'Disconnected',
            disabled: true,
          },
        ]
      : [];

  const options = [...modeOptions, ...disconnectedOption, ...agentOptions];

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
      title="Delegate Session"
      variant="ghost"
      shape="default"
      tone="neutral"
      size="sm"
      align="bottom-left"
      footerSlot={({ dismiss }) => (
        <div className="flex flex-col">
          {onNewThread && (
            <Button
              variant="ghost"
              tone="neutral"
              size="sm"
              onClick={() => {
                onNewThread();
                dismiss();
              }}
              className="w-full justify-start gap-1.5 rounded px-2 py-1.5 text-left"
            >
              <Plus size={14} />
              <span className="text-xs">New Chat Session</span>
            </Button>
          )}
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            onClick={() => {
              void onRefreshAgents?.();
            }}
            disabled={refreshing || !onRefreshAgents}
            className="w-full justify-start gap-1.5 rounded px-2 py-1.5 text-left"
          >
            <RefreshCw
              size={14}
              className={refreshing ? 'animate-spin' : undefined}
            />
            <span className="text-xs">
              {refreshing ? 'Refreshing…' : 'Refresh Agents'}
            </span>
          </Button>
        </div>
      )}
    />
  );
};
