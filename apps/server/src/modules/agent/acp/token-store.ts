/**
 * Token store for the ACP bridge.
 *
 * Currently in-memory with a single shared token sourced from
 * `SEDIMENT_ACP_DEV_TOKEN`. Sufficient for dev/local where one user
 * runs one Sediment server. A canvas-scoped store with a proper token
 * lifecycle (issue / revoke / expire) can replace this when needed.
 */

import type { AuthResult, BridgeHelloParams } from '@agentlet/protocol';

export interface TokenEntry {
  /** Free-form metadata returned from `authenticate`. Currently unused. */
  metadata: Record<string, unknown>;
}

class AcpTokenStore {
  private tokens = new Map<string, TokenEntry>();

  /** Register a token. Idempotent. */
  put(token: string, metadata: Record<string, unknown> = {}): void {
    if (!token) throw new Error('Token must be non-empty');
    this.tokens.set(token, { metadata });
  }

  /** Remove a token. No-op if not present. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  /**
   * Validate the token from a bridge/hello. Throws on rejection (rejection
   * surfaces as ACP error code -32001 INVALID_TOKEN to the agentlet client).
   */
  validate(token: string, _meta: BridgeHelloParams): AuthResult {
    if (!token) throw new Error('Token required');
    const entry = this.tokens.get(token);
    if (!entry) throw new Error('Invalid token');
    return { metadata: entry.metadata };
  }

  /** Test/debug helper. */
  size(): number {
    return this.tokens.size;
  }
}

let _store: AcpTokenStore | null = null;

/**
 * Get the process-wide token store. Lazily seeds a single dev token from
 * `SEDIMENT_ACP_DEV_TOKEN` if set; otherwise the store starts empty and
 * `bridge/hello` will reject every connection until a token is `put()`.
 */
export function getTokenStore(): AcpTokenStore {
  if (_store) return _store;
  const store = new AcpTokenStore();
  const devToken = process.env.SEDIMENT_ACP_DEV_TOKEN;
  if (devToken) {
    store.put(devToken, { source: 'env:SEDIMENT_ACP_DEV_TOKEN' });
  }
  _store = store;
  return store;
}

/** Test-only: reset the singleton. */
export function _resetTokenStoreForTests(): void {
  _store = null;
}
