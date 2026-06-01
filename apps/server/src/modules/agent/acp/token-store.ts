/**
 * Token store for the ACP bridge.
 *
 * In-memory map of accepted bridge tokens. Seeding is centralised in
 * `./config.ts` — at server boot (and on every Settings UI flip) the
 * config module calls {@link AcpTokenStore.put} / `.revoke` to reflect
 * the persisted `data/acp-config.json` state. The store stays empty
 * while the bridge is disabled, so every `bridge/hello` is rejected
 * without consulting any feature flag.
 *
 * Legacy `ACP_DEV_TOKEN` env support lives in `./config.ts` too — it
 * acts as a one-shot fallback the first time the server boots without
 * a JSON config file.
 *
 * A canvas-scoped store with a proper token lifecycle (issue / revoke
 * / expire) can replace this when needed.
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
 * Get the process-wide token store. The store starts empty; the active
 * bridge token is installed by `./config.ts` after reading
 * `data/acp-config.json` (or the legacy `ACP_DEV_TOKEN` env fallback).
 * While no token is installed, every `bridge/hello` is rejected.
 */
export function getTokenStore(): AcpTokenStore {
  if (!_store) _store = new AcpTokenStore();
  return _store;
}

/** Test-only: reset the singleton. */
export function _resetTokenStoreForTests(): void {
  _store = null;
}
