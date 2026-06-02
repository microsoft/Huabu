/**
 * ACP (external agent bridge) pairing section in the Settings popover.
 *
 * The section presents a single mental model:
 *
 *   "Pick an agent → get a launch command."
 *
 * Two sources feed that flow inside one card:
 *
 *  1. **Detected agents** — the server probes the host for installed
 *     ACP-capable CLIs (Copilot / Claude / Gemini). Each is rendered
 *     as a row with name + version, an optional `--allow-all` toggle
 *     (only shown when the CLI exposes one), and a **Connect** button
 *     that mints a fresh pairing code AND builds the exact
 *     `agentlet --token … --agent "…"` command, copying it to the
 *     clipboard. Right under the detected-agent list, the active-code
 *     slot then renders a **persistent "paste this into a terminal"
 *     panel** showing the same command in a code block with a copy
 *     button + countdown — so the next-step instruction survives toast
 *     timeouts and stays visible until the agent actually pairs.
 *
 *  2. **Connect manually** — a compact fallback row with a **Generate
 *     code** button for users who want to launch agentlet themselves
 *     (custom args, custom binary, remote shell, etc.). This flow has
 *     no associated command, so the active-code slot falls back to
 *     showing just the bare pairing code.
 *
 * At any moment there is at most ONE active pairing code — the store's
 * `createTicket` revokes any prior pending ticket before minting a
 * new one, and the UI only renders one ticket as a single "active
 * code" slot. The list of connected agents lives in the chat panel's
 * agent picker (see `useAcpAgents`), so this view does not double as
 * a connection manager — the post-Connect "Connected · alias" success
 * row is scoped to the current popover session by tracking the
 * just-minted ticket id in component-local state (`sessionTicketId`):
 * it disappears the moment the popover closes, and reopening Settings
 * with a still-online claimed ticket from another flow does NOT
 * re-echo a row, since that ticket was never registered as
 * session-owned. We resolve the ticket by id rather than reading
 * `tickets[0]` because the server lists tickets in insertion order
 * (oldest first), so any pre-existing claimed ticket from another
 * agent would otherwise push our just-minted pending ticket out of
 * the head slot the moment the next poll lands.
 */

import { Check, ClipboardCopy, Plus, Terminal } from 'lucide-react';
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
import { useAcpAgentsStore } from '@/store/acpAgentsStore';
import { useAcpPairingStore } from '@/store/acpPairingStore';
import useCanvasStore from '@/store/canvasStore';
import { useChatStore } from '@/store/chatStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { AcpAgentCliInfo, AcpPairingTicket } from '@sediment/shared';

/**
 * Custom hook: returns a millisecond-precision "now" that advances
 * roughly every `intervalMs` while `active` is true. Re-uses a single
 * `setInterval` so the countdown stays smooth without re-rendering the
 * whole tree on every tick, and falls back to a static timestamp once
 * `active` flips false so an idle popover doesn't keep React busy.
 */
function useNow(active: boolean, intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Tick immediately on activation so a freshly-minted pending ticket
    // doesn't wait up to `intervalMs` for its first refresh.
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * Powers the "show ✓ for ~1.5s after a successful copy" affordance
 * used by every copy button in this section. Encapsulates the timer +
 * unmount cleanup so each call site doesn't have to manage its own
 * `useRef` + `useEffect` pair (a pattern that was previously
 * duplicated across three components in this file).
 */
function useCopyState(timeoutMs = 1500): {
  copied: boolean;
  trigger: () => void;
} {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);
  const trigger = useCallback(() => {
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, timeoutMs);
  }, [timeoutMs]);
  return { copied, trigger };
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
  /**
   * Called once a Connect click has (a) minted a fresh pairing ticket
   * and (b) built + copied the corresponding launch command. The parent
   * uses this to surface a persistent "paste this in your terminal"
   * panel below the row — the post-Connect signal that survives toast
   * timeouts so users don't miss what to do next.
   */
  onLaunchReady: (info: {
    ticketId: string;
    command: string;
    agentDisplayName: string;
  }) => void;
}

const DetectedAgentRow: React.FC<DetectedAgentRowProps> = ({
  agent,
  agentletOnPath,
  agentletWrapperPath,
  onLaunchReady,
}) => {
  const createTicket = useAcpPairingStore((s) => s.createTicket);
  // Default ON for agents that support it — the whole point of the
  // "Connect" one-click flow is reducing friction; users who care can
  // toggle off before clicking.
  const [allowAll, setAllowAll] = useState<boolean>(
    agent.allowAllFlag !== null,
  );
  const [busy, setBusy] = useState(false);
  const { copied, trigger: markCopied } = useCopyState();

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
      // Best-effort clipboard write — even if it fails (e.g. browser
      // permissions revoked), the persistent panel surfaced below still
      // lets the user copy the command manually, so we don't bail out.
      await copyToClipboard(cmd).catch(() => undefined);
      markCopied();
      // Hand the freshly-built command to the parent so it can render
      // the persistent "paste in your terminal" panel. This is the
      // primary post-click signal — the prior toast disappeared too
      // fast for users to act on.
      onLaunchReady({
        ticketId: ticket.id,
        command: cmd,
        agentDisplayName: agent.displayName,
      });
    } finally {
      setBusy(false);
    }
  }, [
    agent,
    allowAll,
    agentletOnPath,
    agentletWrapperPath,
    createTicket,
    markCopied,
    onLaunchReady,
  ]);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-fg-default text-xs font-medium">
          {agent.displayName}
        </p>
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
          title={`Mint a connection code + copy the launch command for ${agent.displayName}`}
        >
          {copied ? <Check /> : <Terminal />}
          <span>{busy ? 'Generating…' : copied ? 'Copied!' : 'Connect'}</span>
        </Button>
      </div>
    </div>
  );
};

/**
 * Snapshot of what the user just minted in a Connect-flow click:
 * which ticket it bound to + the exact shell command they need to
 * paste in a terminal + the agent display name to put in the panel
 * header. Carried through the parent so the persistent terminal-paste
 * UI survives polling refreshes and toast timeouts.
 */
interface LaunchInfo {
  ticketId: string;
  command: string;
  agentDisplayName: string;
}

interface LaunchCommandPanelProps {
  ticket: AcpPairingTicket;
  command: string;
  agentDisplayName: string;
  now: number;
}

/**
 * Post-Connect "paste this into a terminal" panel. Replaces the prior
 * toast-based instruction with a persistent UI block that survives
 * until the agent actually pairs or the pending ticket expires
 * (~60s). The parent gates rendering so this is only used while the
 * remembered launch command is still bound to the current pending
 * ticket; once the ticket flips to claimed / revoked / replaced, the
 * parent falls back to {@link PairingCodePanel}.
 */
const LaunchCommandPanel: React.FC<LaunchCommandPanelProps> = ({
  ticket,
  command,
  agentDisplayName,
  now,
}) => {
  const { copied, trigger: markCopied } = useCopyState();
  const remainingSec = Math.max(0, Math.ceil((ticket.expiresAt - now) / 1000));

  const handleCopy = useCallback(() => {
    void copyToClipboard(command).then(markCopied);
  }, [command, markCopied]);

  return (
    <div className="px-3 py-3">
      {/* Header: icon + label on one line. Code block and footer hint
          below intentionally start at the panel's left edge (not
          indented under the icon) so wide commands get the full
          available width. */}
      <div className="flex items-center gap-2">
        <Terminal className="text-info h-3.5 w-3.5 shrink-0" />
        <p className="text-fg-default text-xs font-medium">
          Paste this into a terminal to launch {agentDisplayName}
        </p>
      </div>
      <div className="mt-2 flex items-stretch gap-1.5">
        <div className="bg-bg-default text-fg-default border-edge-default min-w-0 flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-nowrap">
          {command}
        </div>
        <Button
          variant="outline"
          tone="info"
          size="sm"
          iconOnly
          title={copied ? 'Copied!' : 'Copy command'}
          onClick={handleCopy}
        >
          {copied ? <Check /> : <ClipboardCopy />}
        </Button>
      </div>
      <p className="text-fg-subtle mt-1.5 text-[11px] leading-snug">
        Code <span className="text-fg-muted font-mono">{ticket.code}</span> ·
        expires in {remainingSec}s · the agent will appear in the chat picker
        once connected.
      </p>
    </div>
  );
};

interface PairingCodePanelProps {
  ticket: AcpPairingTicket;
  now: number;
}

/**
 * Bare-code display used by the Manual ("Generate code") flow and as
 * the fallback when a Connect-flow ticket flips out of the pending
 * state. Renders one of three states:
 *
 *   • pending (window open)    → big code + countdown + copy
 *   • claimed (just witnessed) → "Connected · alias" (success bg)
 *   • pending (window passed)  → "Waiting for agent…" (defensive: the
 *                                server should have dropped this by now)
 *
 * No cancel / disconnect button: pending tickets auto-expire after
 * their 60s window, and disconnecting a claimed agent already lives
 * in the chat panel's agent picker per the module-level "not a
 * connection manager" rule.
 */
const PairingCodePanel: React.FC<PairingCodePanelProps> = ({ ticket, now }) => {
  const { copied, trigger: markCopied } = useCopyState();
  const remainingMs = Math.max(0, ticket.expiresAt - now);
  const remainingSec = Math.ceil(remainingMs / 1000);
  const pendingWindowOpen = ticket.status === 'pending' && remainingMs > 0;

  const handleCopy = useCallback(() => {
    void copyToClipboard(ticket.code).then(markCopied);
  }, [ticket.code, markCopied]);

  let titleNode: React.ReactNode;
  if (pendingWindowOpen) {
    titleNode = (
      <code className="bg-bg-default text-fg-default border-edge-default rounded border px-2 py-0.5 font-mono text-sm font-semibold tracking-widest">
        {ticket.code}
      </code>
    );
  } else if (ticket.status === 'claimed') {
    titleNode = (
      <span className="text-fg-default inline-flex items-center gap-1.5 text-xs font-medium">
        <Check className="text-success h-3.5 w-3.5 shrink-0" />
        Connected · {ticket.claimedAlias ?? 'agent'}
      </span>
    );
  } else {
    titleNode = (
      <span className="text-fg-subtle text-xs">Waiting for agent…</span>
    );
  }

  return (
    <div
      className={`flex items-center justify-between gap-3 px-3 py-2.5 ${
        // Light green success bg only on the claimed confirmation row,
        // so the brief pending→claimed transition lands with an obvious
        // visual cue. Pending and "waiting" states stay neutral so the
        // big code badge / countdown stays the focal point.
        ticket.status === 'claimed' ? 'bg-success-bg' : ''
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">{titleNode}</div>
        {pendingWindowOpen && (
          <p className="text-fg-subtle mt-0.5 truncate text-[11px] leading-snug">
            Expires in {remainingSec}s
          </p>
        )}
      </div>
      {pendingWindowOpen && (
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            tone="info"
            size="sm"
            iconOnly
            title={copied ? 'Copied!' : 'Copy code'}
            onClick={handleCopy}
          >
            {copied ? <Check /> : <ClipboardCopy />}
          </Button>
        </div>
      )}
    </div>
  );
};

/**
 * Derives the single active-ticket view from the store, prioritising
 * the ticket the user just initiated in this popover session
 * (`sessionTicketId`). Falls back to any stray pending ticket so a
 * page refresh doesn't strand the user.
 *
 * We resolve the ticket by id rather than reading `tickets[0]`
 * because the server's `getTokenStore().list()` returns Map insertion
 * order (oldest first), so any pre-existing claimed ticket from
 * another agent would otherwise push our just-minted pending ticket
 * out of the head slot the moment the next 1s poll lands — causing
 * the active-code panel to flicker open then immediately disappear.
 *
 * Returns:
 *  • `activeTicket` — the ticket to render (or null).
 *  • `launchForActive` — the cached launch command IFF it's still
 *    bound to the current pending ticket; degrades to null once the
 *    ticket is claimed, replaced or revoked.
 *  • `activeTicketFromConnect` — true when the active ticket came
 *    from a Connect-flow click. Consumed by the parent to decide
 *    which slot the row renders in. We deliberately keep this true
 *    even after the ticket flips to claimed so a freshly claimed
 *    Connect ticket doesn't visually jump down past the manual row.
 */
function useActivePairingTicket(
  sessionTicketId: string | null,
  lastLaunch: LaunchInfo | null,
): {
  activeTicket: AcpPairingTicket | null;
  launchForActive: LaunchInfo | null;
  activeTicketFromConnect: boolean;
} {
  const tickets = useAcpPairingStore((s) => s.tickets);

  const activeTicket = useMemo<AcpPairingTicket | null>(() => {
    if (sessionTicketId) {
      const t = tickets.find((entry) => entry.id === sessionTicketId);
      if (t) return t;
    }
    // Recovery fallback: surface any stray pending ticket (e.g.
    // leftover from a page refresh) so the user can still copy or
    // wait it out instead of losing the code entirely. Claimed
    // tickets are intentionally NOT surfaced here — that long-lived
    // state belongs in the chat panel's agent picker.
    const pending = tickets.find((entry) => entry.status === 'pending');
    return pending ?? null;
  }, [tickets, sessionTicketId]);

  const launchForActive =
    lastLaunch !== null &&
    activeTicket !== null &&
    lastLaunch.ticketId === activeTicket.id &&
    activeTicket.status === 'pending'
      ? lastLaunch
      : null;

  const activeTicketFromConnect =
    activeTicket !== null &&
    lastLaunch !== null &&
    lastLaunch.ticketId === activeTicket.id;

  return { activeTicket, launchForActive, activeTicketFromConnect };
}

/**
 * Auto-binds the chat panel to a freshly paired external agent. When
 * the user's own session ticket flips from pending → claimed, we set
 * the chat panel's `agentBinding` to that agent (scoped to the
 * current canvas) so the next message goes through it without an
 * extra trip to the New-Chat menu. We refresh the shared connected-
 * agents list BEFORE the binding flip so ChatPanel's stale-binding
 * auto-reset effect sees the new agent on the same render as the new
 * binding (otherwise it would immediately revert to internal). The
 * `autoBoundRef` guard ensures each ticket fires at most one bind
 * even if React re-runs the effect (strict mode dev, dep churn) or
 * the polling refresh delivers the claimed status across multiple
 * renders.
 */
function useAutoBindClaimedAgent(
  activeTicket: AcpPairingTicket | null,
  sessionTicketId: string | null,
): void {
  const autoBoundRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeTicket === null ||
      activeTicket.id !== sessionTicketId ||
      activeTicket.status !== 'claimed' ||
      !activeTicket.claimedAgentId ||
      autoBoundRef.current === activeTicket.id
    ) {
      return;
    }
    autoBoundRef.current = activeTicket.id;
    const claimedAgentId = activeTicket.claimedAgentId;
    const claimedAlias = activeTicket.claimedAlias ?? claimedAgentId;
    void (async () => {
      await useAcpAgentsStore.getState().refresh();
      const canvasId = useCanvasStore.getState().canvasId;
      useChatStore.getState().setAgentBinding(
        {
          kind: 'external',
          alias: claimedAlias,
          agentletAgentId: claimedAgentId,
        },
        canvasId || undefined,
      );
    })();
  }, [activeTicket, sessionTicketId]);
}

export const AcpSettings: React.FC = () => {
  const error = useAcpPairingStore((s) => s.error);
  const createTicket = useAcpPairingStore((s) => s.createTicket);
  // Local in-flight flag for the Manual "Generate code" button. We
  // deliberately do NOT reuse the store's global `creating` flag
  // because that flag is also set during Connect-flow mints — using it
  // here would make Generate code spuriously show "Generating…"
  // whenever the user clicks Connect on a detected agent. Each entry
  // point owns its own busy state; the store remains the single source
  // of truth for the resulting ticket list.
  const [creatingManual, setCreatingManual] = useState(false);

  const {
    agents: detectedAgents,
    agentletOnPath,
    agentletWrapperPath,
    loading: detectionLoading,
    error: detectionError,
    refresh: refreshDetection,
  } = useAgentCliDetection();

  // Single-slot UI: the store enforces ≤1 pending ticket via auto-
  // revoke on create; we render only one ticket so the panel never
  // grows into a scrolling list. Connected agents remain visible in
  // the chat panel's agent picker.
  const [sessionTicketId, setSessionTicketId] = useState<string | null>(null);

  // Remember the most recent Connect-flow launch command so the
  // active-ticket slot can render it as a persistent "paste in your
  // terminal" instruction. We don't bother clearing it on its own —
  // `useActivePairingTicket` only surfaces it while it still matches
  // the current pending ticket, so a stale entry quietly becomes a
  // no-op once the ticket is claimed, revoked or replaced.
  const [lastLaunch, setLastLaunch] = useState<LaunchInfo | null>(null);

  const { activeTicket, launchForActive, activeTicketFromConnect } =
    useActivePairingTicket(sessionTicketId, lastLaunch);

  useAutoBindClaimedAgent(activeTicket, sessionTicketId);

  // Only tick the countdown clock while there's a pending ticket on
  // screen — otherwise an open Settings popover would spin a 250ms
  // interval forever for no UI change.
  const hasPendingTicket = activeTicket?.status === 'pending';
  const now = useNow(hasPendingTicket);

  // Detect a Windows host from the wrapper path the server reported
  // (e.g. `C:\…\bin\agentlet`). Used to surface a one-line hint that
  // the copied command needs Git Bash / WSL — the wrapper itself is a
  // POSIX shell script and won't run in cmd.exe or PowerShell.
  const isWindowsHost = useMemo(
    () =>
      agentletWrapperPath !== null &&
      (/^[A-Za-z]:[\\/]/.test(agentletWrapperPath) ||
        agentletWrapperPath.includes('\\')),
    [agentletWrapperPath],
  );

  // Surface store / detection errors as transient toasts.
  useEffect(() => {
    if (error) toast(error, { variant: 'error' });
  }, [error]);
  useEffect(() => {
    if (detectionError) toast(detectionError, { variant: 'error' });
  }, [detectionError]);

  const handleLaunchReady = useCallback((info: LaunchInfo) => {
    setLastLaunch(info);
    // Mark this ticket as the one the user just initiated in this
    // popover session — `useActivePairingTicket` resolves it by id
    // even after the polling refresh re-shuffles the tickets array.
    setSessionTicketId(info.ticketId);
  }, []);

  // Manual flow: mint a bare token. The store auto-revokes any prior
  // pending ticket (Connect-flow or manual), so clicking this while a
  // Connect command panel is visible will replace it — the two flows
  // are mutually exclusive by design, never coexisting.
  const handleGenerate = useCallback(async () => {
    setCreatingManual(true);
    try {
      const ticket = await createTicket();
      if (ticket) setSessionTicketId(ticket.id);
    } finally {
      setCreatingManual(false);
    }
  }, [createTicket]);

  // Renders the active-ticket slot: rich Connect-flow panel when we
  // have a bound launch command, otherwise the bare-code variant.
  // Defined inline so the two slot positions below render an
  // identical component without duplicating the conditional.
  const renderActiveTicket = (ticket: AcpPairingTicket) =>
    launchForActive !== null ? (
      <LaunchCommandPanel
        ticket={ticket}
        command={launchForActive.command}
        agentDisplayName={launchForActive.agentDisplayName}
        now={now}
      />
    ) : (
      <PairingCodePanel ticket={ticket} now={now} />
    );

  return (
    <SettingSection title="External Agents">
      {/* Windows-host banner: the wrapper is a POSIX shell script and
          won't run in cmd.exe / PowerShell, so we set expectations
          before the user copies any command. */}
      {isWindowsHost && (
        <p className="text-fg-muted bg-hover px-3 py-2 text-[11px] leading-snug">
          On Windows, run the copied command in{' '}
          <span className="text-fg-default font-medium">Git Bash</span> or{' '}
          <span className="text-fg-default font-medium">WSL</span> — cmd.exe and
          PowerShell can&apos;t execute the <code>agentlet</code> wrapper
          directly.
        </p>
      )}

      {/* Detected-agent rows: the primary one-click path. */}
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
            Install one of: <code className="font-mono">@github/copilot</code>,{' '}
            <code className="font-mono">@anthropic-ai/claude-code</code>,{' '}
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
        detectedAgents.map((agent) => (
          <DetectedAgentRow
            key={agent.id}
            agent={agent}
            agentletOnPath={agentletOnPath}
            agentletWrapperPath={agentletWrapperPath}
            onLaunchReady={handleLaunchReady}
          />
        ))
      )}

      {/* Active-code slot — Connect flow: sits right under the
          detected-agent list so the persistent "paste in your
          terminal" panel appears immediately below the row the user
          just clicked. Manual-flow tickets render in the second slot
          further down, next to the "Connect manually" row. */}
      {activeTicket !== null &&
        activeTicketFromConnect &&
        renderActiveTicket(activeTicket)}

      {/* Manual fallback: bare token for power users. Reuses the
          shared SettingRow layout — the title + description + right-
          aligned control pattern matches it exactly, so no need to
          hand-roll the flex container. */}
      <SettingRow
        title="Connect manually (advanced)"
        description="Mints a bare token. Use this if you launch agentlet yourself with custom args or a remote shell."
      >
        <Button
          variant="outline"
          tone="neutral"
          size="sm"
          onClick={() => {
            void handleGenerate();
          }}
          disabled={creatingManual}
        >
          <Plus />
          <span>{creatingManual ? 'Generating…' : 'Generate code'}</span>
        </Button>
      </SettingRow>

      {/* Active-code slot — Manual flow: sits directly under the
          "Connect manually (advanced)" row for the same proximity
          reason as the Connect-flow slot above. */}
      {activeTicket !== null &&
        !activeTicketFromConnect &&
        renderActiveTicket(activeTicket)}

      {/* Path-hint footer only shown when needed. */}
      {!agentletOnPath && detectedAgents.length > 0 && (
        <p className="text-fg-subtle px-3 py-2 text-[11px] leading-snug">
          Tip: <code className="font-mono">agentlet</code> isn&apos;t on your{' '}
          <code>PATH</code> yet — the copied command uses the wrapper&apos;s
          full path. To use the short form, re-run{' '}
          <code className="font-mono">pnpm install</code> or open a new
          terminal.
        </p>
      )}
    </SettingSection>
  );
};
