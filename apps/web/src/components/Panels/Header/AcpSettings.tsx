/**
 * ACP (external agent bridge) pairing section in the Settings popover.
 *
 * Surfaces two complementary entry points:
 *
 *  1. **Detected agents** — the server probes the host for installed
 *     ACP-capable CLIs (Copilot / Claude / Gemini). For each one we
 *     render a small card with name + version, an optional
 *     `--allow-all` toggle (only shown when the CLI exposes one), and
 *     a single "Connect" button that mints a fresh pairing code AND
 *     builds the exact `agentlet --token … --agent "…"` command,
 *     copying it to the clipboard so the user just pastes it in a
 *     terminal. This is the zero-friction first-time path.
 *
 *  2. **Manual pairing** — the original "Generate code" button is
 *     kept as a fallback for power users who want to launch agentlet
 *     themselves (custom args, custom binary, remote shell, etc.).
 *
 * The actual code is only displayed while a ticket is still in its
 * pending 60-second window. Once claimed (or expired), the code is
 * hidden and only the claimed agent's identity remains visible — so
 * the secret is on screen for as little time as possible
 * (screen-share / shoulder-surf friendly).
 *
 * The store polls `GET /api/acp/pair` once a second while any
 * pending ticket is visible so the countdown stays accurate and the
 * pending → claimed transition surfaces immediately.
 *
 * Visibility: rendered inside the Settings popover, below
 * {@link LLMSettings}. The popover's `init` callback triggers
 * `useAcpPairingStore.init()` so the data is ready by the time the
 * user opens this section.
 */

import { Check, ClipboardCopy, Plus, Terminal, X } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { listAcpAgentClis } from '@/api/acp';
import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useAcpPairingStore } from '@/store/acpPairingStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { AcpAgentCliInfo, AcpPairingTicket } from '@sediment/shared';

/**
 * Custom hook: returns a millisecond-precision "now" that advances
 * roughly every 250ms while the component is mounted. We use this
 * rather than a `setInterval(force update)` directly so the countdown
 * stays smooth without re-rendering the whole tree on every tick.
 */
function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * One-shot fetch of host-side agent CLI detection. Re-runs on demand
 * via the returned `refresh` callback (e.g. after the user installs a
 * CLI in a separate terminal and wants to see it appear without a
 * full page reload).
 *
 * Errors are surfaced as `error` state and also funnelled through the
 * shared toast bus so the user notices even if the section isn't
 * scrolled into view.
 */
function useAgentCliDetection(): {
  agents: AcpAgentCliInfo[];
  agentletOnPath: boolean;
  agentletWrapperPath: string | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [agents, setAgents] = useState<AcpAgentCliInfo[]>([]);
  const [agentletOnPath, setAgentletOnPath] = useState(false);
  const [agentletWrapperPath, setAgentletWrapperPath] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listAcpAgentClis()
      .then((res) => {
        if (cancelled) return;
        setAgents(res.agents);
        setAgentletOnPath(res.agentletOnPath);
        setAgentletWrapperPath(res.agentletWrapperPath);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to detect installed agent CLIs';
        setError(msg);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  return {
    agents,
    agentletOnPath,
    agentletWrapperPath,
    loading,
    error,
    refresh,
  };
}

/**
 * Build the exact shell command we want the user to paste in a
 * terminal: agentlet wrapper + the just-minted token + the agent's
 * launch command (binary + acpArgs + optional allow-all flag).
 *
 * The agent command itself is wrapped in double quotes because it
 * contains a space, e.g. `--agent "copilot --acp --allow-all"`.
 * When `agentletOnPath` is true we emit the short form `agentlet …`;
 * otherwise we fall back to the absolute path to the in-repo wrapper
 * so the command works from any CWD.
 */
function buildLaunchCommand(opts: {
  agent: AcpAgentCliInfo;
  allowAll: boolean;
  token: string;
  agentletOnPath: boolean;
  agentletWrapperPath: string | null;
}): string {
  const { agent, allowAll, token, agentletOnPath, agentletWrapperPath } = opts;
  const parts = [agent.binary, ...agent.acpArgs];
  if (allowAll && agent.allowAllFlag) parts.push(agent.allowAllFlag);
  const agentCmd = parts.join(' ');
  const wrapper = agentletOnPath
    ? 'agentlet'
    : (agentletWrapperPath ?? 'bin/agentlet');
  return `${wrapper} --token ${token} --agent "${agentCmd}"`;
}

interface DetectedAgentRowProps {
  agent: AcpAgentCliInfo;
  agentletOnPath: boolean;
  agentletWrapperPath: string | null;
}

const DetectedAgentRow: React.FC<DetectedAgentRowProps> = ({
  agent,
  agentletOnPath,
  agentletWrapperPath,
}) => {
  const createTicket = useAcpPairingStore((s) => s.createTicket);
  // Default ON for agents that support it — the whole point of the
  // "Connect" one-click flow is reducing friction; users who care can
  // toggle off before clicking.
  const [allowAll, setAllowAll] = useState<boolean>(
    agent.allowAllFlag !== null,
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleConnect = useCallback(async () => {
    setBusy(true);
    try {
      const ticket = await createTicket();
      if (!ticket) return; // store already surfaced an error toast
      const cmd = buildLaunchCommand({
        agent,
        allowAll: allowAll && agent.allowAllFlag !== null,
        token: ticket.code,
        agentletOnPath,
        agentletWrapperPath,
      });
      await copyToClipboard(cmd);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
      toast(
        `Copied launch command for ${agent.displayName}. Paste into a terminal within 60s.`,
        { variant: 'success' },
      );
    } finally {
      setBusy(false);
    }
  }, [agent, allowAll, agentletOnPath, agentletWrapperPath, createTicket]);

  return (
    <div className="border-edge-default flex items-center justify-between gap-3 border-t px-3 py-2.5 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-fg-default text-sm font-medium">
            {agent.displayName}
          </span>
          {agent.version && (
            <span className="text-fg-subtle font-mono text-[11px]">
              {agent.version}
            </span>
          )}
        </div>
        {agent.allowAllFlag !== null && (
          <label className="text-fg-muted mt-1 inline-flex cursor-pointer items-center gap-1.5 text-[11px] select-none">
            <input
              type="checkbox"
              className="accent-info h-3 w-3"
              checked={allowAll}
              onChange={(e) => setAllowAll(e.target.checked)}
              disabled={busy}
            />
            <span>
              Auto-approve tool calls (
              <code className="font-mono">{agent.allowAllFlag}</code>)
            </span>
          </label>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          tone="info"
          size="sm"
          onClick={() => {
            void handleConnect();
          }}
          disabled={busy}
          title={`Mint a pairing code + copy the launch command for ${agent.displayName}`}
        >
          {copied ? <Check /> : <Terminal />}
          <span>{busy ? 'Generating…' : copied ? 'Copied!' : 'Connect'}</span>
        </Button>
      </div>
    </div>
  );
};

interface TicketRowProps {
  ticket: AcpPairingTicket;
  now: number;
  onRevoke: (id: string) => void;
  revoking: boolean;
}

const TicketRow: React.FC<TicketRowProps> = ({
  ticket,
  now,
  onRevoke,
  revoking,
}) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopy = useCallback(() => {
    void copyToClipboard(ticket.code).then(() => {
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 1500);
    });
  }, [ticket.code]);

  const handleRevoke = useCallback(() => {
    onRevoke(ticket.id);
  }, [onRevoke, ticket.id]);

  const remainingMs = Math.max(0, ticket.expiresAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const pendingWindowOpen = ticket.status === 'pending' && remainingMs > 0;

  // Title / subtitle differ across the three observable display states:
  //   • pending (window open)  → big code + countdown
  //   • claimed                → agent identity (alias + command)
  //   • pending (window passed)→ "Waiting for agent…" (rare: the server
  //                              already dropped this; we usually never
  //                              render it, but render defensively in
  //                              case a poll race leaves a stale row)
  const titleNode = useMemo(() => {
    if (pendingWindowOpen) {
      return (
        <code className="text-fg-default border-edge-default rounded border px-2 py-0.5 font-mono text-sm font-semibold tracking-widest">
          {ticket.code}
        </code>
      );
    }
    if (ticket.status === 'claimed') {
      return (
        <span className="text-fg-default text-xs font-medium">
          Paired · {ticket.claimedAlias ?? 'agent'}
        </span>
      );
    }
    return <span className="text-fg-subtle text-xs">Waiting for agent…</span>;
  }, [pendingWindowOpen, ticket]);

  const subtitle = useMemo(() => {
    if (pendingWindowOpen) {
      return `Valid for ${remainingSec}s — paste into bin/agentlet --token`;
    }
    if (ticket.status === 'claimed') {
      return ticket.claimedCommand
        ? `Connected via "${ticket.claimedCommand}"`
        : 'Connected.';
    }
    return undefined;
  }, [pendingWindowOpen, remainingSec, ticket]);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">{titleNode}</div>
        {subtitle && (
          <p className="text-fg-subtle mt-0.5 truncate text-[11px] leading-snug">
            {subtitle}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {pendingWindowOpen && (
          <Button
            variant="ghost"
            tone="neutral"
            size="sm"
            iconOnly
            title={copied ? 'Copied!' : 'Copy code'}
            onClick={handleCopy}
          >
            {copied ? <Check /> : <ClipboardCopy />}
          </Button>
        )}
        <Button
          variant="ghost"
          tone="danger"
          size="sm"
          iconOnly
          title={
            ticket.status === 'claimed'
              ? 'Disconnect this agent'
              : 'Cancel pairing code'
          }
          onClick={handleRevoke}
          disabled={revoking}
        >
          <X />
        </Button>
      </div>
    </div>
  );
};

export const AcpSettings: React.FC = () => {
  const tickets = useAcpPairingStore((s) => s.tickets);
  const creating = useAcpPairingStore((s) => s.creating);
  const revoking = useAcpPairingStore((s) => s.revoking);
  const error = useAcpPairingStore((s) => s.error);
  const createTicket = useAcpPairingStore((s) => s.createTicket);
  const revokeTicket = useAcpPairingStore((s) => s.revokeTicket);

  const {
    agents: detectedAgents,
    agentletOnPath,
    agentletWrapperPath,
    loading: detectionLoading,
    error: detectionError,
    refresh: refreshDetection,
  } = useAgentCliDetection();

  const now = useNow();

  // Surface store errors as transient toasts.
  useEffect(() => {
    if (error) {
      toast(error, { variant: 'error' });
    }
  }, [error]);

  // Surface detection errors too — but only once per failure (the
  // `detectionError` string is stable across re-renders until refresh).
  useEffect(() => {
    if (detectionError) {
      toast(detectionError, { variant: 'error' });
    }
  }, [detectionError]);

  const handleGenerate = useCallback(() => {
    void createTicket();
  }, [createTicket]);

  // We surface every active ticket — pending (with countdown still
  // running), claimed (agent connected), plus anything else the server
  // happens to be reporting. Stale entries get filtered by the next
  // poll naturally; no special "expired" branch needed.
  const visibleTickets = tickets;

  return (
    <>
      <SettingSection title="Detected Agents">
        {detectionLoading ? (
          <div className="text-fg-subtle px-3 py-2.5 text-xs">
            Scanning your machine for installed agent CLIs…
          </div>
        ) : detectedAgents.length === 0 ? (
          <div className="px-3 py-2.5 text-xs">
            <p className="text-fg-muted">
              No ACP-capable agent CLI found on your <code>PATH</code>.
            </p>
            <p className="text-fg-subtle mt-1 leading-snug">
              Install one of: <code className="font-mono">@github/copilot</code>
              , <code className="font-mono">@anthropic-ai/claude-code</code>,{' '}
              <code className="font-mono">@google/gemini-cli</code> — then{' '}
              <button
                type="button"
                onClick={refreshDetection}
                className="text-info hover:underline"
              >
                re-scan
              </button>
              .
            </p>
          </div>
        ) : (
          <>
            {detectedAgents.map((agent) => (
              <DetectedAgentRow
                key={agent.id}
                agent={agent}
                agentletOnPath={agentletOnPath}
                agentletWrapperPath={agentletWrapperPath}
              />
            ))}
            {!agentletOnPath && (
              <p className="text-fg-subtle border-edge-default border-t px-3 py-2 text-[11px] leading-snug">
                Tip: <code className="font-mono">agentlet</code> isn&apos;t on
                your <code>PATH</code> yet — the copied command uses the
                wrapper&apos;s full path. To use the short form, re-run{' '}
                <code className="font-mono">pnpm install</code> or open a new
                terminal.
              </p>
            )}
          </>
        )}
      </SettingSection>

      <SettingSection title="External Agents">
        <SettingRow
          title="Pair manually (advanced)"
          description={
            'Mints a bare token. Use this if you launch agentlet yourself with custom args or a remote shell.'
          }
        >
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            onClick={handleGenerate}
            disabled={creating}
          >
            <Plus />
            <span>{creating ? 'Generating…' : 'Generate code'}</span>
          </Button>
        </SettingRow>

        {visibleTickets.map((ticket) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            now={now}
            onRevoke={revokeTicket}
            revoking={revoking[ticket.id] === true}
          />
        ))}
      </SettingSection>
    </>
  );
};
