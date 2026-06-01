/**
 * ACP (external agent bridge) pairing section in the Settings popover.
 *
 * Lets the user:
 *  - Generate a fresh ephemeral pairing code (60 second pending window;
 *    once an agentlet successfully claims it the code is bound to that
 *    agent's `agentId` so subsequent reconnects keep working).
 *  - Copy the displayed code to the clipboard.
 *  - Revoke any active ticket (pending or claimed).
 *
 * UI behaviour:
 *  - The actual code is only displayed while a ticket is still in its
 *    pending window. Once the 60-second countdown elapses (or the
 *    ticket gets claimed), the code is hidden and only the claimed
 *    agent's display info remains visible — so the secret is on screen
 *    for as little time as possible (screen-share / shoulder-surf
 *    friendly).
 *  - The store polls `GET /api/acp/pair` once a second while any
 *    pending ticket is visible so the countdown stays accurate and
 *    the pending → claimed transition surfaces immediately.
 *
 * Visibility: rendered inside the Settings popover, below
 * {@link LLMSettings}. The popover's `init` callback triggers
 * `useAcpPairingStore.init()` so the data is ready by the time the
 * user opens this section.
 */

import { Check, ClipboardCopy, Plus, X } from 'lucide-react';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from '@/components/Common/Button';
import { SettingRow } from '@/components/Common/SettingRow';
import { SettingSection } from '@/components/Common/SettingSection';
import { toast } from '@/components/Common/Toast';
import { useAcpPairingStore } from '@/store/acpPairingStore';
import { copyToClipboard } from '@/utils/io/clipboard';

import type { AcpPairingTicket } from '@sediment/shared';

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

  const now = useNow();

  // Surface store errors as transient toasts.
  useEffect(() => {
    if (error) {
      toast(error, { variant: 'error' });
    }
  }, [error]);

  const handleGenerate = useCallback(() => {
    void createTicket();
  }, [createTicket]);

  // We surface every active ticket — pending (with countdown still
  // running), claimed (agent connected), plus anything else the server
  // happens to be reporting. Stale entries get filtered by the next
  // poll naturally; no special "expired" branch needed.
  const visibleTickets = tickets;

  return (
    <SettingSection title="External Agents">
      <SettingRow
        title="Pair an external agent"
        description={
          'Generate a one-time code, then run `bin/agentlet --token <code> --agent "…"` from a terminal.'
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
  );
};
