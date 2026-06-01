/**
 * Ephemeral pairing-token store for the ACP bridge.
 *
 * Lifecycle of a single ticket (see `AcpPairingTicket` in
 * `@sediment/shared` for the wire shape):
 *
 *   pending  → newly minted via {@link createTicket}. Stays in this
 *              state until either (a) some agentlet sends a
 *              `bridge/hello` whose token matches → transitions to
 *              `claimed` and is bound to that `agentId`, or (b) the
 *              60-second pending window elapses → the ticket is
 *              dropped from the store and any subsequent `bridge/hello`
 *              with the same code is rejected.
 *
 *   claimed  → bound to a specific `agentId`. Future `bridge/hello`
 *              attempts with this token succeed iff their `agentId`
 *              matches the one recorded at claim time. This is what
 *              allows agentlet's built-in auto-reconnect (wifi blips,
 *              dev hot-reloads, laptop sleep) to keep working without
 *              re-pairing.
 *
 *   <gone>   → graceful disconnect, explicit revoke, or server restart
 *              all remove the ticket entirely. There is no "claimed
 *              but disconnected" zombie state.
 *
 * All state is in-memory and per-process. Pairing tokens are never
 * written to disk.
 *
 * Concurrency notes
 * -----------------
 * `validate` is called from the agentlet WS handshake (single-threaded
 * inside the Node event loop) so the `pending → claimed` transition
 * is naturally atomic with respect to other claims of the same code.
 * Two simultaneous `bridge/hello` against the same pending ticket would
 * see one win and the other fail with "token already claimed by another
 * agent" — the loser's `agentId` won't match.
 */

import { randomBytes, randomUUID } from 'node:crypto';

import type { BridgeHelloParams, AuthResult } from '@agentlet/protocol';
import type { AcpPairingTicket } from '@sediment/shared';

/** Unambiguous uppercase character set used for the visible code. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Pending tickets live for 60 seconds before being auto-dropped. */
export const PAIRING_PENDING_TTL_MS = 60_000;

/**
 * Internal in-memory record. Mirrors {@link AcpPairingTicket} but adds
 * the expiry timer handle so {@link close} can clear it cleanly.
 */
interface StoredTicket {
  id: string;
  code: string;
  status: 'pending' | 'claimed';
  expiresAt: number;
  claimedAgentId?: string;
  claimedAlias?: string;
  claimedCommand?: string;
  claimedAt?: number;
  /** Active setTimeout handle; cleared on claim, expiry, or revoke. */
  pendingTimer: NodeJS.Timeout | null;
}

export type TokenEntry = AcpPairingTicket;

/**
 * Lightweight derivation of the human-readable alias from the agent's
 * launcher command. Kept in sync with `agents.route.deriveAlias` —
 * duplicated here to avoid pulling the route module into the security
 * boundary.
 */
function deriveAliasFromCommand(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? '';
  if (!first) return 'agent';
  const basename = first.split('/').pop() ?? first;
  return basename || 'agent';
}

function generateCode(): string {
  const bytes = randomBytes(8);
  const raw = Array.from(bytes)
    .map((b) => CODE_CHARS[b % CODE_CHARS.length])
    .join('');
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

function toWireTicket(t: StoredTicket): AcpPairingTicket {
  return {
    id: t.id,
    code: t.code,
    status: t.status,
    expiresAt: t.expiresAt,
    claimedAgentId: t.claimedAgentId,
    claimedAlias: t.claimedAlias,
    claimedCommand: t.claimedCommand,
    claimedAt: t.claimedAt,
  };
}

class AcpTokenStore {
  /** Keyed by `code` for O(1) lookup from `validate`. */
  private byCode = new Map<string, StoredTicket>();
  /** Secondary index by `id` for `revoke` and `list`-by-id needs. */
  private byId = new Map<string, StoredTicket>();

  /**
   * Mint a fresh pending ticket. The caller (the pair route) is the only
   * code path that should generate codes — agentlet never sees this.
   */
  createTicket(): AcpPairingTicket {
    // Guard against the astronomically unlikely collision; just retry.
    let code = generateCode();
    while (this.byCode.has(code)) code = generateCode();

    const id = randomUUID();
    const now = Date.now();
    const ticket: StoredTicket = {
      id,
      code,
      status: 'pending',
      expiresAt: now + PAIRING_PENDING_TTL_MS,
      pendingTimer: setTimeout(() => {
        // Only drop if still pending; a claim before this fires will
        // have cleared the timer.
        const current = this.byId.get(id);
        if (current && current.status === 'pending') {
          this.byCode.delete(current.code);
          this.byId.delete(current.id);
        }
      }, PAIRING_PENDING_TTL_MS),
    };
    this.byCode.set(code, ticket);
    this.byId.set(id, ticket);
    return toWireTicket(ticket);
  }

  /**
   * Validate an incoming `bridge/hello`. Throws on rejection (the
   * agentlet protocol layer turns the throw into a -32001 INVALID_TOKEN
   * error returned to the client and closes the socket).
   *
   * Side effects:
   *  - pending → claimed transition (also clears the pending timer)
   *  - alias / command snapshot for the UI
   */
  validate(token: string, meta: BridgeHelloParams): AuthResult {
    if (!token) throw new Error('Token required');
    const ticket = this.byCode.get(token);
    if (!ticket) throw new Error('Invalid or expired pairing code');

    const agentId = meta.agentId;
    if (!agentId) throw new Error('bridge/hello missing agentId');

    if (ticket.status === 'pending') {
      // Atomic claim — the timer is cancelled so the pending sweep
      // can't drop the ticket from under us.
      if (ticket.pendingTimer) {
        clearTimeout(ticket.pendingTimer);
        ticket.pendingTimer = null;
      }
      ticket.status = 'claimed';
      ticket.claimedAgentId = agentId;
      ticket.claimedAlias = deriveAliasFromCommand(meta.agent?.command ?? '');
      ticket.claimedCommand = meta.agent?.command;
      ticket.claimedAt = Date.now();
      return { metadata: { ticketId: ticket.id } };
    }

    // Already claimed — only the same agentId may keep using this token.
    if (ticket.claimedAgentId !== agentId) {
      throw new Error('Pairing code already claimed by another agent');
    }
    ticket.claimedAt = Date.now();
    return { metadata: { ticketId: ticket.id } };
  }

  /**
   * Drop every ticket bound to the given `agentId`. Invoked by the
   * agentlet server's `onDisconnection` callback so a graceful close
   * (or any close event from `ws`) immediately invalidates the token
   * — a fresh pairing is required to reconnect.
   */
  markDisconnected(agentId: string): void {
    for (const ticket of Array.from(this.byId.values())) {
      if (ticket.claimedAgentId === agentId) {
        this.removeTicket(ticket);
      }
    }
  }

  /** Drop the ticket with the given id. No-op if not present. */
  revoke(id: string): boolean {
    const ticket = this.byId.get(id);
    if (!ticket) return false;
    this.removeTicket(ticket);
    return true;
  }

  /** Snapshot every active ticket for the Settings UI. */
  list(): AcpPairingTicket[] {
    return Array.from(this.byId.values()).map(toWireTicket);
  }

  /** Process shutdown: clear every pending timer so the event loop can exit. */
  close(): void {
    for (const ticket of this.byId.values()) {
      if (ticket.pendingTimer) clearTimeout(ticket.pendingTimer);
    }
    this.byCode.clear();
    this.byId.clear();
  }

  /** Internal — single removal path so both indexes + timer stay in sync. */
  private removeTicket(ticket: StoredTicket): void {
    if (ticket.pendingTimer) {
      clearTimeout(ticket.pendingTimer);
      ticket.pendingTimer = null;
    }
    this.byCode.delete(ticket.code);
    this.byId.delete(ticket.id);
  }

  /** Test/debug helper. */
  size(): number {
    return this.byId.size;
  }
}

let _store: AcpTokenStore | null = null;

/**
 * Get the process-wide pairing-token store. Starts empty; tickets are
 * created on demand by the user via the Settings UI.
 */
export function getTokenStore(): AcpTokenStore {
  if (!_store) _store = new AcpTokenStore();
  return _store;
}

/** Test-only: reset the singleton (clears timers too). */
export function _resetTokenStoreForTests(): void {
  if (_store) _store.close();
  _store = null;
}
