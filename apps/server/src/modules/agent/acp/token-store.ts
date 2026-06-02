/**
 * Pairing-token store for the ACP bridge.
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
 *   <gone>   → explicit revoke removes the ticket entirely. A WebSocket
 *              close (which the agentlet/server layer reports as
 *              "disconnected" for *any* close — there is no signal that
 *              distinguishes a deliberate Ctrl-C from a transient drop)
 *              starts a {@link PAIRING_RECONNECT_GRACE_MS} grace timer;
 *              the ticket is removed only if no `bridge/hello` for the
 *              same agentId lands inside that window. Successful
 *              re-validate cancels the timer.
 *
 * Persistence
 * -----------
 * Claimed tickets are persisted to `data/acp-tickets.json` so that
 * server restarts do not force the user back to the Settings UI to
 * re-pair every already-connected agentlet. The same trust model as
 * `data/oauth-credentials.json` / `data/llm-config.json` applies:
 * loopback-only access and best-effort `chmod 0600`. Pending tickets
 * remain ephemeral (the 60-second TTL makes persistence pointless) and
 * are dropped on restart.
 *
 * On startup the constructor rehydrates every persisted record back
 * into the in-memory `byCode` / `byId` maps with `disconnectedAt = null`
 * (the previous grace-timer state cannot be recovered, so we give every
 * rehydrated ticket a fresh "online" slate). Writes happen on:
 *   - pending → claimed transition (initial pairing)
 *   - revoke and grace-window expiry (via `removeTicket`)
 *
 * Reconnect-only updates to `claimedAt` / `disconnectedAt` are NOT
 * written; they are in-memory liveness signals that would otherwise
 * thrash the file on every WS heartbeat.
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { BridgeHelloParams, AuthResult } from '@agentlet/protocol';
import type { AcpPairingTicket } from '@sediment/shared';

/** Unambiguous uppercase character set used for the visible code. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Pending tickets live for 60 seconds before being auto-dropped. */
export const PAIRING_PENDING_TTL_MS = 60_000;

/**
 * After {@link AcpTokenStore.markDisconnected} fires we keep the ticket
 * around for this long so the agentlet client's auto-reconnect (wifi
 * blips, dev hot-reloads, laptop sleep — see
 * `external/agentlet/packages/local/src/bridge.ts`) has a chance to
 * re-establish without forcing the user back to the Settings UI.
 *
 * Tuned to match agentlet's default `--reconnect-max` (300s): once the
 * client gives up reconnecting, we expire the ticket too so a leaked
 * code cannot be re-used by a third party that learns the agentId
 * later.
 */
export const PAIRING_RECONNECT_GRACE_MS = 5 * 60 * 1000;

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
  /**
   * Epoch ms when {@link AcpTokenStore.markDisconnected} last fired for
   * the bound agentId, or `null` while the agent is considered live.
   * A successful re-validate clears this back to `null`.
   */
  disconnectedAt: number | null;
  /**
   * Active grace timer queued by {@link AcpTokenStore.markDisconnected};
   * removes the ticket once {@link PAIRING_RECONNECT_GRACE_MS} elapses
   * without a successful re-validate. Cleared on reconnect, revoke, or
   * shutdown.
   */
  graceTimer: NodeJS.Timeout | null;
}

export type TokenEntry = AcpPairingTicket;

/**
 * On-disk shape for a single persisted (claimed) ticket. Mirrors the
 * fields of {@link StoredTicket} that matter for re-establishing a
 * claim across server restarts; the timer handles and `disconnectedAt`
 * are deliberately omitted because they are runtime-only.
 */
interface PersistedTicket {
  id: string;
  code: string;
  expiresAt: number;
  claimedAgentId: string;
  claimedAlias?: string;
  claimedCommand?: string;
  claimedAt?: number;
}

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
   * Absolute path to the JSON file used to persist claimed tickets.
   * `null` disables persistence entirely (used by unit tests so the
   * existing in-memory test suite stays filesystem-free).
   */
  private readonly persistPath: string | null;

  constructor(persistPath: string | null) {
    this.persistPath = persistPath;
    this.rehydrate();
  }

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
      disconnectedAt: null,
      graceTimer: null,
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
      // Persist now so a server restart between claim and the next
      // bridge/hello doesn't force the user to re-pair.
      this.persist();
      return { metadata: { ticketId: ticket.id } };
    }

    // Already claimed — only the same agentId may keep using this token.
    if (ticket.claimedAgentId !== agentId) {
      throw new Error('Pairing code already claimed by another agent');
    }
    // Reconnect succeeded — cancel any in-flight disconnect grace timer
    // so the ticket stays alive past PAIRING_RECONNECT_GRACE_MS.
    if (ticket.graceTimer) {
      clearTimeout(ticket.graceTimer);
      ticket.graceTimer = null;
    }
    ticket.disconnectedAt = null;
    ticket.claimedAt = Date.now();
    return { metadata: { ticketId: ticket.id } };
  }

  /**
   * Called by the agentlet server's `onDisconnection` callback for every
   * WebSocket close (the underlying `ws` event surfaces no signal that
   * distinguishes a deliberate Ctrl-C from a transient drop). We start a
   * {@link PAIRING_RECONNECT_GRACE_MS} grace window during which the
   * ticket stays alive; if no `bridge/hello` for the same agentId lands
   * before the window elapses, the ticket is removed. A successful
   * reconnect inside the window cancels the timer (see {@link validate}).
   *
   * Idempotent — re-firing for an already-grace-pending ticket leaves
   * the original timer running so the grace window is not extended by
   * spurious close events.
   */
  markDisconnected(agentId: string): void {
    for (const ticket of Array.from(this.byId.values())) {
      if (ticket.claimedAgentId !== agentId) continue;
      if (ticket.graceTimer) continue;
      ticket.disconnectedAt = Date.now();
      ticket.graceTimer = setTimeout(() => {
        // Only remove if still in grace (reconnect would have cleared
        // graceTimer + disconnectedAt). Re-look up in case the ticket
        // was already removed via revoke / shutdown.
        const current = this.byId.get(ticket.id);
        if (current && current.graceTimer) {
          this.removeTicket(current);
        }
      }, PAIRING_RECONNECT_GRACE_MS);
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
      if (ticket.graceTimer) clearTimeout(ticket.graceTimer);
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
    if (ticket.graceTimer) {
      clearTimeout(ticket.graceTimer);
      ticket.graceTimer = null;
    }
    const wasClaimed = ticket.status === 'claimed';
    this.byCode.delete(ticket.code);
    this.byId.delete(ticket.id);
    // Only claimed tickets are persisted, so a pending-only removal
    // doesn't need to touch disk.
    if (wasClaimed) this.persist();
  }

  /**
   * Load claimed tickets from {@link persistPath} into the in-memory
   * indexes. Safe to call before any tickets exist — missing file or
   * corrupted JSON both produce an empty starting state.
   */
  private rehydrate(): void {
    if (!this.persistPath) return;
    if (!existsSync(this.persistPath)) return;
    let entries: unknown;
    try {
      entries = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
    } catch {
      // Corrupted file — drop it so the next persist() rewrites cleanly
      // and the user can re-pair if needed.
      try {
        unlinkSync(this.persistPath);
      } catch {
        // Best-effort cleanup; ignore.
      }
      return;
    }
    if (!Array.isArray(entries)) return;
    for (const raw of entries) {
      const entry = raw as Partial<PersistedTicket>;
      // Defensive: skip records missing fields required to re-validate.
      if (
        typeof entry.id !== 'string' ||
        typeof entry.code !== 'string' ||
        typeof entry.claimedAgentId !== 'string'
      ) {
        continue;
      }
      const ticket: StoredTicket = {
        id: entry.id,
        code: entry.code,
        status: 'claimed',
        expiresAt:
          typeof entry.expiresAt === 'number' ? entry.expiresAt : Date.now(),
        claimedAgentId: entry.claimedAgentId,
        claimedAlias: entry.claimedAlias,
        claimedCommand: entry.claimedCommand,
        claimedAt: entry.claimedAt,
        pendingTimer: null,
        // Rehydrated tickets start with a clean "online" slate; if the
        // agent never reconnects, the next markDisconnected → grace
        // window will eventually purge them.
        disconnectedAt: null,
        graceTimer: null,
      };
      this.byCode.set(ticket.code, ticket);
      this.byId.set(ticket.id, ticket);
    }
  }

  /**
   * Snapshot every claimed ticket and atomically rewrite the persistence
   * file. Atomic via temp-file + rename so a `kill -9` mid-write cannot
   * leave a half-written JSON behind. Persistence failures are swallowed
   * — losing the rewrite means the next restart falls back to whatever
   * was last successfully written, which is strictly better than
   * crashing the request that triggered the write.
   */
  private persist(): void {
    if (!this.persistPath) return;
    const claimedList: PersistedTicket[] = Array.from(this.byId.values())
      .filter(
        (t): t is StoredTicket & { claimedAgentId: string } =>
          t.status === 'claimed' && typeof t.claimedAgentId === 'string',
      )
      .map((t) => ({
        id: t.id,
        code: t.code,
        expiresAt: t.expiresAt,
        claimedAgentId: t.claimedAgentId,
        claimedAlias: t.claimedAlias,
        claimedCommand: t.claimedCommand,
        claimedAt: t.claimedAt,
      }));
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(claimedList, null, 2), 'utf-8');
      renameSync(tmp, this.persistPath);
      try {
        chmodSync(this.persistPath, 0o600);
      } catch {
        // Windows ACLs don't translate cleanly from POSIX mode bits;
        // matches the best-effort pattern used by llm.ts / oauth.ts.
      }
    } catch {
      // Surfacing this as a thrown error would fail the agentlet
      // handshake, which is far worse than the next restart losing this
      // one update.
    }
  }

  /** Test/debug helper. */
  size(): number {
    return this.byId.size;
  }
}

/** Default location of the persisted claimed-ticket file. */
function defaultPersistPath(): string {
  return join(process.cwd(), 'data', 'acp-tickets.json');
}

let _store: AcpTokenStore | null = null;
/**
 * Override for the persistence path. `undefined` means "use the default";
 * `null` disables persistence entirely (used by the existing in-memory
 * test suite); a string overrides it (used by the persistence test
 * suite to point at a tmpdir file).
 */
let _persistPathOverride: string | null | undefined = undefined;

/**
 * Get the process-wide pairing-token store. The first call materializes
 * the singleton and rehydrates any previously claimed tickets from
 * `data/acp-tickets.json` so server restarts do not invalidate already
 * paired agentlets.
 */
export function getTokenStore(): AcpTokenStore {
  if (!_store) {
    const path =
      _persistPathOverride === undefined
        ? defaultPersistPath()
        : _persistPathOverride;
    _store = new AcpTokenStore(path);
  }
  return _store;
}

/** Test-only: reset the singleton (clears timers too). */
export function _resetTokenStoreForTests(): void {
  if (_store) _store.close();
  _store = null;
}

/**
 * Test-only: control where claimed tickets are persisted. Pass `null`
 * to disable persistence entirely, a path to redirect writes to a
 * scratch location, or omit (`undefined`) to fall back to the default
 * `data/acp-tickets.json`. The override takes effect on the next
 * {@link getTokenStore} call after {@link _resetTokenStoreForTests}.
 */
export function _setPersistPathForTests(path: string | null): void {
  _persistPathOverride = path;
}
