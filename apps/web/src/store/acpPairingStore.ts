/**
 * Front-end mirror of `/api/acp/pair` — the ephemeral pairing-ticket
 * surface for the external-agent (ACP) bridge.
 *
 * Lifecycle from the UI's perspective:
 *
 *   1. User opens the Settings popover → {@link init} fires (idempotent
 *      first load).
 *   2. User clicks "Generate code" → {@link createTicket} POSTs and
 *      prepends the returned ticket to the local list.
 *   3. While *any* pending ticket is visible, the store polls
 *      `GET /api/acp/pair` every {@link POLL_INTERVAL_MS} so the UI
 *      reflects (a) the countdown smoothly and (b) the pending→claimed
 *      transition when an agentlet successfully hellos. Polling auto-
 *      stops when no pending ticket remains, to keep the request rate
 *      to zero in the idle case.
 *   4. User can {@link revokeTicket} to invalidate a ticket on demand.
 *
 * Pending tickets that pass their `expiresAt` deadline server-side are
 * dropped from `list()`; the next poll naturally removes them from the
 * UI without a special "expired" entry.
 */

import { create } from 'zustand';

import {
  createAcpPairing,
  listAcpPairings,
  revokeAcpPairing,
} from '../api/acp';

import type { AcpPairingTicket } from '@sediment/shared';

/** Poll cadence while any pending ticket is on screen. */
const POLL_INTERVAL_MS = 1_000;

interface AcpPairingState {
  /** Currently-known tickets (pending + claimed). */
  tickets: AcpPairingTicket[];
  /** True while the first `init` fetch is in flight. */
  loading: boolean;
  /** True while a `createTicket` POST is in flight. */
  creating: boolean;
  /** Per-ticket revoke-in-flight flags, keyed by ticket id. */
  revoking: Record<string, boolean>;
  /** Last error string from any of the calls. */
  error: string | null;

  /** Idempotent first load. */
  init: () => Promise<void>;
  /** Force a fresh GET. Safe to call concurrently. */
  refresh: () => Promise<void>;
  /** Mint a new pending ticket. Prepended to {@link tickets} on success. */
  createTicket: () => Promise<void>;
  /** Revoke a ticket by id. Removes it from {@link tickets} on success. */
  revokeTicket: (id: string) => Promise<void>;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Ensure the polling loop is running iff any pending ticket exists.
 * Called after every state change that could flip the predicate.
 */
function syncPolling(
  tickets: AcpPairingTicket[],
  refresh: () => Promise<void>,
): void {
  const now = Date.now();
  const hasPending = tickets.some(
    (t) => t.status === 'pending' && t.expiresAt > now,
  );
  if (hasPending && pollTimer === null) {
    pollTimer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
  } else if (!hasPending && pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export const useAcpPairingStore = create<AcpPairingState>()((set, get) => ({
  tickets: [],
  loading: false,
  creating: false,
  revoking: {},
  error: null,

  init: async () => {
    if (get().loading || get().tickets.length > 0) {
      // Already loaded (or loading) — but still re-arm polling in case
      // the popover was closed and re-opened with pending tickets still
      // visible from the previous mount.
      syncPolling(get().tickets, get().refresh);
      return;
    }
    set({ loading: true, error: null });
    try {
      const { tickets } = await listAcpPairings();
      set({ tickets, loading: false });
      syncPolling(tickets, get().refresh);
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to load pairing codes',
        loading: false,
      });
    }
  },

  refresh: async () => {
    try {
      const { tickets } = await listAcpPairings();
      set({ tickets, error: null });
      syncPolling(tickets, get().refresh);
    } catch (err) {
      set({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to refresh pairing codes',
      });
    }
  },

  createTicket: async () => {
    set({ creating: true, error: null });
    try {
      const ticket = await createAcpPairing();
      const tickets = [ticket, ...get().tickets];
      set({ tickets, creating: false });
      syncPolling(tickets, get().refresh);
    } catch (err) {
      set({
        error:
          err instanceof Error ? err.message : 'Failed to create pairing code',
        creating: false,
      });
    }
  },

  revokeTicket: async (id) => {
    set({ revoking: { ...get().revoking, [id]: true } });
    try {
      await revokeAcpPairing(id);
      const tickets = get().tickets.filter((t) => t.id !== id);
      const revoking = { ...get().revoking };
      delete revoking[id];
      set({ tickets, revoking });
      syncPolling(tickets, get().refresh);
    } catch (err) {
      const revoking = { ...get().revoking };
      delete revoking[id];
      set({
        error:
          err instanceof Error ? err.message : 'Failed to revoke pairing code',
        revoking,
      });
    }
  },
}));
