/**
 * Agentlet authentication for the embedded agentlet server.
 *
 * One Sediment instance manages exactly one agentlet (forked as a child
 * of the server process — see {@link ../daemon-supervisor.ts}). The auth
 * model is correspondingly trivial:
 *
 *   1. At each server boot (and on every supervisor-driven re-fork)
 *      a fresh 256-bit hex token is minted via {@link rotateToken}.
 *   2. The supervisor passes that token to the child via env / argv
 *      and {@link setDaemonToken} stores it in this process.
 *   3. The agentlet's `agentlet/hello` arrives carrying its profile.
 *      {@link validate} accepts the handshake iff the token matches.
 *
 * No persistence: the token only ever lives in memory of the parent
 * server process and the agentlet child it just forked. A restart of
 * either side rotates the token.
 *
 * Two kinds of handshake reach this validator, both legitimate:
 *
 *   - `role: 'agentlet'` — the supervised agentlet registering its
 *     control channel after each fork.
 *   - `role: 'session'` — per-agent relay sockets opened by our own
 *     agentlet every time it spawns a CLI agent, so the server can
 *     register an `AgentConnection` and ferry ACP traffic.
 *
 * Both paths must present the current agentlet token, which is rotated
 * per supervisor fork and only ever leaves this process inside the
 * env/argv of the agentlet child we just forked.
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
 * instantiate fresh per-test in vitest.
 */
class AcpDaemonAuth {
  private token: string | null = null;

  /** Replace the active token. Called by the supervisor on each fork. */
  setDaemonToken(token: string): void {
    this.token = token;
  }

  /**
   * Mint and store a fresh 256-bit hex token. The supervisor calls
   * this once per fork and forwards the return value to the daemon
   * child process.
   */
  rotateToken(): string {
    const next = randomBytes(32).toString('hex');
    this.token = next;
    return next;
  }

  /** Current token, or `null` if the supervisor has not booted yet. */
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
   * it spawns. Both present the same agentlet token (rotated per fork,
   * only ever leaves this process inside the env/argv of the agentlet
   * child) so we accept any handshake that matches it.
   *
   * Reasons we reject:
   *  - The agentlet supervisor has not finished booting (no token set).
   *  - The supplied token doesn't match the current agentlet token.
   */
  validate(
    token: string,
    _meta: AgentHelloParams | AgentletHelloParams,
  ): AuthResult {
    if (!this.token) {
      throw new Error('Daemon supervisor has not finished initialising');
    }
    if (!token || token !== this.token) {
      throw new Error('Invalid daemon token');
    }
    return { metadata: { source: 'daemon' } };
  }

  /** Test/teardown helper — drops the in-memory token. */
  close(): void {
    this.token = null;
  }
}

let _instance: AcpDaemonAuth | null = null;

/**
 * Process-wide accessor for the daemon authenticator. First call
 * lazily creates the singleton — there is no rehydration step because
 * the only state (the token) is regenerated each fork.
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
