/**
 * Daemon authentication for the embedded agentlet bridge.
 *
 * One Sediment instance manages exactly one agentlet daemon (forked
 * as a child of the server process — see {@link ../daemon-supervisor.ts}).
 * The auth model is correspondingly trivial:
 *
 *   1. At each server boot (and on every supervisor-driven re-fork)
 *      a fresh 256-bit hex token is minted via {@link rotateToken}.
 *   2. The supervisor passes that token to the child via env / argv
 *      and {@link setDaemonToken} stores it in this process.
 *   3. The daemon's `bridge/hello` arrives carrying `mode: 'daemon'`
 *      plus the same token. {@link validate} accepts the handshake
 *      iff both checks pass.
 *
 * No persistence: the token only ever lives in memory of the parent
 * server process and the daemon child it just forked. A restart of
 * either side rotates the token; the legacy `data/acp-tickets.json`
 * persistence file used by the old per-CLI pairing flow has been
 * removed (the supervisor unlinks it once on boot).
 *
 * Bridge mode (per-CLI agent connections without a daemon) is no
 * longer accepted on this bridge — the only legitimate client is our
 * own daemon. Rejecting `mode !== 'daemon'` here closes off a sloppy
 * loopback-only escape hatch even before the auth check runs.
 */

import { randomBytes } from 'node:crypto';

import type { AuthResult, BridgeHelloParams } from '@agentlet/protocol';

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
   * Validate an incoming `bridge/hello`. Throws on rejection — the
   * agentlet protocol layer maps the throw to a -32001 INVALID_TOKEN
   * response and closes the socket (see `external/agentlet/packages/
   * server/src/server.ts#handleHello`).
   *
   * Reasons we reject:
   *  - The daemon supervisor has not finished booting (no token set).
   *  - The handshake is not in `daemon` mode (legacy bridge handshakes
   *    are no longer supported by Sediment).
   *  - The supplied token doesn't match the current daemon token.
   */
  validate(token: string, meta: BridgeHelloParams): AuthResult {
    if (!this.token) {
      throw new Error('Daemon supervisor has not finished initialising');
    }
    if (meta.mode !== 'daemon') {
      throw new Error('Only daemon handshakes are accepted on this bridge');
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
