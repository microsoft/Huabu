/**
 * Agentlet authentication for the embedded Gateway.
 *
 * One Agenetes host manages exactly one agentlet (forked as a child of
 * the server process — see {@link ./daemon-supervisor.ts}). The auth
 * model is correspondingly trivial:
 *
 *   1. The host supplies a single `connectionToken` at
 *      {@link ../index.ts mountAgenetes} time — a global, non-ephemeral
 *      value owned by L1 config (M4). {@link setDaemonToken} stores it
 *      in this process.
 *   2. The supervisor passes that token to the child via env / argv.
 *   3. The agentlet's `agentlet/hello` arrives carrying its profile.
 *      {@link validate} accepts the handshake iff the token matches.
 *
 * No persistence: the token lives only in memory of the parent server
 * process and the agentlet child it forked. Unlike the previous
 * per-fork mint, the token no longer rotates on re-fork — it is a
 * stable, host-injected value, so agent reachback credentials (e.g. the
 * RFS bearer the host validates) survive a daemon restart.
 *
 * Two kinds of handshake reach this validator, both legitimate:
 *
 *   - `role: 'agentlet'` — the supervised agentlet registering its
 *     control channel after each fork.
 *   - `role: 'session'` — per-agent relay sockets opened by our own
 *     agentlet every time it spawns a CLI agent, so the server can
 *     register an `AgentConnection` and ferry ACP traffic.
 *
 * Both paths must present the current agentlet token.
 */

import { randomBytes } from 'node:crypto';

import type {
  AuthResult,
  AgentHelloParams,
  AgentletHelloParams,
} from '@agentlet/protocol';

/**
 * In-memory daemon token + handshake validator.
 *
 * Singleton because there is exactly one bridge per server process.
 * The class shape (rather than module-level state) keeps it cheap to
 * instantiate fresh per-test.
 */
class AcpDaemonAuth {
  private token: string | null = null;
  private agentletId: string | null = null;

  /**
   * Set the active token. Called once by `mountAgenetes` with the
   * host-injected `connectionToken`.
   */
  setDaemonToken(token: string): void {
    this.token = token;
  }

  /** Configure the identity and token accepted for the supervised daemon. */
  configure(agentletId: string, token: string): void {
    this.agentletId = agentletId;
    this.token = token;
  }

  /**
   * Mint and store a fresh 256-bit hex token. Retained for tests /
   * fallback; the production path injects a stable token via
   * {@link setDaemonToken} instead of rotating per fork.
   */
  rotateToken(): string {
    const next = randomBytes(32).toString('hex');
    this.token = next;
    return next;
  }

  /** Current token, or `null` if `mountAgenetes` has not run yet. */
  getToken(): string | null {
    return this.token;
  }

  /**
   * Validate an incoming `agentlet/hello` or `agent/hello`. Throws on
   * rejection — the agentlet protocol layer maps the throw to a -32001
   * INVALID_TOKEN response and closes the socket.
   *
   * The supervised agentlet opens two kinds of WebSocket against this
   * server: a single `role: 'agentlet'` control channel for itself, and
   * one per-session relay socket (`role: 'session'`) for every CLI agent
   * it spawns. Both present the same agentlet token so we accept any
   * handshake that matches it.
   *
   * Reasons we reject:
   *  - `mountAgenetes` has not run yet (no token set).
   *  - The supplied token doesn't match the current agentlet token.
   */
  validate(
    token: string,
    _meta: AgentHelloParams | AgentletHelloParams,
  ): AuthResult {
    if (!this.token) {
      throw new Error('Agenetes host has not finished initialising');
    }
    if (!token || token !== this.token) {
      throw new Error('Invalid daemon token');
    }
    return { metadata: { source: 'daemon' } };
  }

  /** Validate the Gateway identity/token authentication port. */
  validateAgentlet(agentletId: string, token: string): AuthResult {
    if (this.agentletId && agentletId !== this.agentletId) {
      throw new Error('Invalid supervised agentlet identity');
    }
    return this.validate(token, {} as AgentletHelloParams);
  }

  /** Test/teardown helper — drops the in-memory token. */
  close(): void {
    this.token = null;
    this.agentletId = null;
  }
}

let _instance: AcpDaemonAuth | null = null;

/**
 * Process-wide accessor for the daemon authenticator. First call
 * lazily creates the singleton — there is no rehydration step because
 * the only state (the token) is set from host config on mount.
 */
export function getDaemonAuth(): AcpDaemonAuth {
  if (!_instance) _instance = new AcpDaemonAuth();
  return _instance;
}

/** Test-only: reset the singleton between tests. */
export function _resetDaemonAuthForTests(): void {
  if (_instance) _instance.close();
  _instance = null;
}
